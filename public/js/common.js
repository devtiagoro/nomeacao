// NOMEIA — utilidades compartilhadas (ES module, sem dependências).
// Todo texto vindo do servidor é inserido via textContent (nunca innerHTML) para evitar XSS.
// Todos os caminhos são relativos: funciona na raiz do servidor Node e em subpastas (GitHub Pages).

import { API_BASE } from './config.js';

const SERVER = String(API_BASE || '').replace(/\/+$/, '');

/** URL absoluta de um recurso do servidor Node (API, QR, WebSocket). */
export function apiUrl(path) {
  return `${SERVER}${path}`;
}

/** true quando as páginas estão em hospedagem estática separada do servidor Node. */
export const isRemoteServer = Boolean(SERVER) && SERVER !== location.origin;

/** Hospedagem estática (ex.: GitHub Pages) sem servidor configurado em js/config.js. */
export const serverMissing = !SERVER && /\.github\.io$/i.test(location.hostname);

/** Endereço do painel administrativo: sempre servido pelo próprio servidor Node (sessão segura). */
export function adminUrl(params = '') {
  return isRemoteServer ? `${SERVER}/admin.html${params}` : `admin.html${params}`;
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Chamada HTTP JSON. O servidor é sempre a autoridade; nada é enfileirado offline. */
export async function api(path, { method = 'GET', body, signal } = {}) {
  if (serverMissing) {
    throw new ApiError(0, 'server_not_configured', 'Servidor do NOMEIA não configurado nesta publicação (js/config.js).');
  }
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-Nomeia'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Sem conexão com o servidor. Verifique a internet/Wi-Fi e tente novamente.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* corpo vazio */
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || 'http_error', e.message || `Erro ${res.status}.`);
  }
  return data;
}

/** Cria elementos de forma segura: el('p', {class: 'x'}, 'texto', filho). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function setText(sel, text) {
  const n = typeof sel === 'string' ? $(sel) : sel;
  if (n) n.textContent = text;
}

/** Anúncio para leitores de tela (região aria-live). */
export function announce(message, { assertive = false } = {}) {
  const id = assertive ? 'live-assertive' : 'live-polite';
  let region = document.getElementById(id);
  if (!region) {
    region = el('div', { id, class: 'sr-only', 'aria-live': assertive ? 'assertive' : 'polite', role: assertive ? 'alert' : 'status' });
    document.body.append(region);
  }
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

export const STATUS_LABEL = {
  draft: 'Aguardando cargo',
  discussing: 'Em discussão',
  voting_open: 'Votação aberta',
  closed: 'Votação encerrada',
  archived: 'Reunião encerrada',
  active: 'Ativa',
};

export function fmtPct(n) {
  return `${Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------- Preferência local ----------------
// Guarda apenas qual reunião foi aberta por último (atalho de navegação).
// Nunca é usado para limitar votos.

function safeStorage(kind) {
  try {
    const s = window[kind];
    const k = '__nomeia_test__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export const storage = {
  lastMeeting() {
    return safeStorage('localStorage')?.getItem('nomeia:lastMeeting') || null;
  },
  rememberMeeting(meetingId) {
    safeStorage('localStorage')?.setItem('nomeia:lastMeeting', meetingId);
  },
};

export const isMeetingId = (v) => typeof v === 'string' && /^m_[A-Za-z0-9_-]{12}$/.test(v);

// ---------------- Tempo real ----------------

/**
 * Conecta ao canal da reunião com reconexão automática (backoff exponencial com jitter),
 * heartbeat de aplicação e ressincronização ao voltar para a aba/app.
 * Cada mensagem traz o snapshot completo + versão; mensagens antigas são descartadas,
 * repetidas apenas re-renderizam o mesmo estado (idempotente).
 */
export function connectLive({ meetingId, role = 'public', onState, onStatus = () => {}, onFatal = () => {} }) {
  let ws = null;
  let lastVersion = -1;
  let retry = 0;
  let pingTimer = null;
  let pongTimer = null;
  let reconnectTimer = null;
  let stopped = false;

  const url = () => {
    const base = SERVER ? new URL(SERVER) : location;
    const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${base.host}/ws?meeting=${encodeURIComponent(meetingId)}${role === 'admin' ? '&role=admin' : ''}`;
  };

  function stopPing() {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('{"type":"ping"}');
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => ws && ws.close(), 8000);
      }
    }, 20000);
  }

  function schedule() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(15000, 500 * 2 ** retry) * (0.5 + Math.random() / 2);
    retry = Math.min(retry + 1, 6);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    onStatus('connecting');
    const sock = new WebSocket(url());
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      onStatus('online');
      startPing();
    };
    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        clearTimeout(pongTimer);
        return;
      }
      if (!msg.state || typeof msg.version !== 'number') return;
      if (msg.version < lastVersion) return; // fora de ordem/antigo
      lastVersion = msg.version;
      onState(msg.state, msg.type, msg.version);
    };
    sock.onclose = (ev) => {
      if (sock !== ws) return;
      stopPing();
      if (stopped) return;
      if (ev.code === 4401 || ev.code === 4404) {
        onStatus('offline');
        onFatal(ev.code === 4401 ? 'unauthorized' : 'not_found');
        return;
      }
      onStatus('offline');
      schedule();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    };
  }

  function resync() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"type":"sync"}');
    else {
      retry = 0;
      connect();
    }
  }

  // PWA/aba volta ao primeiro plano: buscar o estado atual imediatamente.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resync();
  });
  window.addEventListener('online', resync);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) resync();
  });

  if (serverMissing) {
    onStatus('offline');
    onFatal('server_not_configured');
    return { resync() {}, close() {} };
  }
  connect();
  return {
    resync,
    close() {
      stopped = true;
      stopPing();
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

// ---------------- Conectividade e PWA ----------------

export function setupOfflineBar() {
  const bar = el(
    'div',
    { class: 'offline-bar', role: 'status', hidden: true },
    icon('wifi-off'),
    el('span', {}, 'Sem conexão. Votos não são enviados offline.'),
  );
  document.body.prepend(bar);
  const update = () => {
    bar.hidden = navigator.onLine;
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return bar;
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  }
}

export function statusChip(node, status) {
  const labels = { online: 'Ao vivo', offline: 'Reconectando…', connecting: 'Conectando…' };
  node.className = `chip ${status}`;
  node.textContent = labels[status] || status;
  node.title = status === 'online' ? 'Conectado ao servidor: atualizações em tempo real' : 'Sem conexão com o servidor no momento';
}

// ---------------- Ícones (SVG lineares, 24×24) ----------------

const SVG_NS = 'http://www.w3.org/2000/svg';

// p: path(d) · c: circle(cx,cy,r) · r: rect(x,y,w,h,rx)
const ICONS = {
  check: ['p:M20 6 9 17l-5-5'],
  'check-circle': ['c:12,12,9', 'p:m8.5 12.5 2.5 2.5 4.5-5'],
  x: ['p:M18 6 6 18', 'p:M6 6l12 12'],
  plus: ['p:M12 5v14', 'p:M5 12h14'],
  edit: ['p:M12 20h9', 'p:M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  trash: ['p:M3 6h18', 'p:M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6', 'p:m19 6-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6', 'p:M10 11v6', 'p:M14 11v6'],
  play: ['c:12,12,9', 'p:m10 8.5 5 3.5-5 3.5Z'],
  lock: ['r:5,11,14,10,2', 'p:M8 11V7a4 4 0 0 1 8 0v4'],
  stop: ['c:12,12,9', 'r:9,9,6,6,1'],
  'arrow-right': ['p:M5 12h14', 'p:m13 6 6 6-6 6'],
  'arrow-left': ['p:M19 12H5', 'p:m11 18-6-6 6-6'],
  monitor: ['r:3,4,18,12,2', 'p:M8 20h8', 'p:M12 16v4'],
  history: ['p:M3 12a9 9 0 1 0 3-6.7L3 8', 'p:M3 3v5h5', 'p:M12 7v5l3 2'],
  users: ['c:9,8,3.5', 'p:M2.5 20a6.5 6.5 0 0 1 13 0', 'p:M16 4.6a3.5 3.5 0 0 1 0 6.8', 'p:M21.5 20a6.5 6.5 0 0 0-4-6'],
  user: ['c:12,8,4', 'p:M4 21a8 8 0 0 1 16 0'],
  download: ['p:M12 4v11', 'p:m7 10 5 5 5-5', 'p:M5 20h14'],
  upload: ['p:M12 20V9', 'p:m7 14 5-5 5 5', 'p:M5 4h14'],
  copy: ['r:9,9,12,12,2', 'p:M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  external: ['p:M14 4h6v6', 'p:M20 4 11 13', 'p:M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  qr: ['r:3,3,7,7,1', 'r:14,3,7,7,1', 'r:3,14,7,7,1', 'p:M14 14h3v3h-3z', 'p:M20 14v.01', 'p:M14 20h.01', 'p:M17 20h3v-3'],
  printer: ['p:M7 9V3h10v6', 'r:3,9,18,8,2', 'p:M7 14h10v7H7z'],
  logout: ['p:M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'p:m10 17-5-5 5-5', 'p:M5 12h11'],
  alert: ['p:M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'p:M12 9v4', 'p:M12 17h.01'],
  info: ['c:12,12,9', 'p:M12 16v-4', 'p:M12 8h.01'],
  'wifi-off': ['p:m2 2 20 20', 'p:M8.5 16.4a5 5 0 0 1 7 0', 'p:M5 12.8a10 10 0 0 1 5.2-2.7', 'p:M19 12.8a10 10 0 0 0-2.3-1.6', 'p:M2 9a15 15 0 0 1 4.3-2.6', 'p:M22 9a15 15 0 0 0-10.4-4', 'p:M12 20h.01'],
  ballot: ['r:4,3,16,18,2', 'p:m8.5 11.5 2.5 2.5 4.5-5', 'p:M8 17h8'],
  chart: ['p:M4 20h16', 'r:6,11,3,6,0.5', 'r:11,6,3,11,0.5', 'r:16,9,3,8,0.5'],
  bars: ['p:M4 6h10', 'p:M4 12h16', 'p:M4 18h7'],
  key: ['c:7.5,15.5,4.5', 'p:m10.7 12.3 9.8-9.8', 'p:m17 5 3 3', 'p:m14.5 7.5 2 2'],
  shield: ['p:M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z', 'p:m9 12 2 2 4-4'],
  maximize: ['p:M4 9V4h5', 'p:M20 9V4h-5', 'p:M4 15v5h5', 'p:M20 15v5h-5'],
  archive: ['r:3,4,18,4,1', 'p:M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'p:M10 12h4'],
  database: ['p:M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z', 'p:M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'p:M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  eye: ['p:M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'c:12,12,3'],
  refresh: ['p:M20 11a8 8 0 0 0-14.9-3.5L3 10', 'p:M3 4v6h6', 'p:M4 13a8 8 0 0 0 14.9 3.5L21 14', 'p:M21 20v-6h-6'],
  clock: ['c:12,12,9', 'p:M12 7v5l3 2'],
  link: ['p:M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1', 'p:M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1'],
  sliders: ['p:M4 6h10', 'p:M18 6h2', 'c:16,6,2', 'p:M4 12h2', 'p:M10 12h10', 'c:8,12,2', 'p:M4 18h10', 'p:M18 18h2', 'c:16,18,2'],
  calendar: ['r:3,5,18,16,2', 'p:M3 10h18', 'p:M8 3v4', 'p:M16 3v4'],
  minus: ['p:M5 12h14'],
  inbox: ['p:M3 13h5l2 3h4l2-3h5', 'p:M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5Z'],
};

export function icon(name, { label, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${className}`.trim());
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  for (const spec of ICONS[name] || ICONS.info) {
    const kind = spec[0];
    const data = spec.slice(2);
    let node;
    if (kind === 'p') {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', data);
    } else if (kind === 'c') {
      const [cx, cy, r] = data.split(',');
      node = document.createElementNS(SVG_NS, 'circle');
      for (const [k, v] of Object.entries({ cx, cy, r })) node.setAttribute(k, v);
    } else {
      const [x, y, width, height, rx] = data.split(',');
      node = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of Object.entries({ x, y, width, height, rx })) node.setAttribute(k, v);
    }
    svg.append(node);
  }
  return svg;
}

/** Substitui <span data-icon="nome"> estáticos pelos SVGs correspondentes. */
export function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll('[data-icon]:not([data-icon-ready])')) {
    n.prepend(icon(n.dataset.icon));
    n.setAttribute('data-icon-ready', '');
  }
}

hydrateIcons();

// ---------------- Toasts e confirmações ----------------

/** Mensagem breve e não crítica (sucesso/informação). Erros importantes usam banners. */
export function toast(text, kind = 'success') {
  if (!text) return;
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = el(
    'div',
    { class: `toast toast-${kind}` },
    icon(kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'check-circle'),
    el('span', {}, text),
  );
  host.append(t);
  requestAnimationFrame(() => t.classList.add('is-in'));
  setTimeout(() => {
    t.classList.remove('is-in');
    setTimeout(() => t.remove(), 260);
  }, 3800);
}

/**
 * Diálogo modal acessível (foco preso pelo navegador, Esc cancela). Retorna Promise<boolean>.
 * Em ações perigosas o foco inicial fica em "Cancelar".
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false, iconName } = {}) {
  if (typeof HTMLDialogElement !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${message || ''}`));
  return new Promise((resolve) => {
    const uid = Math.random().toString(36).slice(2);
    const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button' }, confirmLabel);
    const cancel = el('button', { class: 'btn btn-secondary', type: 'button' }, cancelLabel);
    const dlg = el(
      'dialog',
      { class: `modal${danger ? ' modal-danger' : ''}`, 'aria-labelledby': `dlg-t-${uid}`, 'aria-describedby': message ? `dlg-d-${uid}` : null },
      el('div', { class: 'modal-icon' }, icon(iconName || (danger ? 'alert' : 'info'))),
      el('h2', { id: `dlg-t-${uid}`, class: 'modal-title' }, title),
      message ? el('p', { id: `dlg-d-${uid}`, class: 'modal-text' }, message) : null,
      el('div', { class: 'modal-actions' }, cancel, ok),
    );
    const previous = document.activeElement;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      previous?.focus?.();
      resolve(value);
    };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    (danger ? cancel : ok).focus();
  });
}

// ---------------- Resultados ----------------

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function barRow({ name, votes, pct, pctLabel, className = '', badges = [] }) {
  const fill = el('span', { class: 'bar-fill' });
  const row = el(
    'li',
    { class: `result-row ${className}`.trim() },
    el(
      'div',
      { class: 'result-head' },
      el('span', { class: 'result-name' }, name),
      ...badges,
      el('span', { class: 'result-nums' }, el('strong', {}, String(votes)), ` ${votes === 1 ? 'voto' : 'votos'} · ${fmtPct(pct)}`),
    ),
    el('div', { class: 'bar', role: 'img', 'aria-label': `${name}: ${plural(votes, 'voto', 'votos')}, ${fmtPct(pct)} ${pctLabel}` }, fill),
  );
  row.dataset.pct = String(Math.max(0, Math.min(100, pct)));
  return row;
}

/**
 * Resultado completo: todos os candidatos (inclusive com zero votos), abstenções separadas,
 * empate identificado e resumo de participação. Nunca declara eleito: apenas "mais votado".
 * animate=true anima as barras a partir de zero (respeita prefers-reduced-motion).
 */
export function renderResults(results, { showAbstain = true, animate = false, compact = false } = {}) {
  const leaders = new Set(results.leaders || []);
  const sorted = [...results.candidates].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'pt-BR'));
  const list = el('ol', { class: 'results', 'aria-label': 'Resultado por candidato' });
  for (const c of sorted) {
    const isLeader = leaders.has(c.id);
    const badges = isLeader ? [el('span', { class: `result-badge${results.tie ? ' tie' : ''}` }, results.tie ? 'Empate' : 'Mais votado')] : [];
    list.append(
      barRow({ name: c.name, votes: c.votes, pct: c.pctValid, pctLabel: 'dos votos válidos', className: isLeader ? 'is-leader' : '', badges }),
    );
  }
  if (showAbstain) {
    list.append(
      barRow({ name: 'Abstenções', votes: results.abstentions, pct: results.abstentionPctCast, pctLabel: 'dos votos registrados', className: 'is-abstain' }),
    );
  }

  const notes = [];
  if (results.tie) {
    const names = results.candidates.filter((c) => leaders.has(c.id)).map((c) => c.name);
    notes.push(el('p', { class: 'banner warn' }, icon('alert'), el('span', {}, `Empate entre ${names.join(' e ')}, com ${plural(results.maxVotes, 'voto', 'votos')} cada.`)));
  } else if (!leaders.size) {
    notes.push(el('p', { class: 'banner info' }, icon('info'), el('span', {}, 'Nenhum candidato recebeu votos.')));
  }
  if (results.singleCandidate) {
    notes.push(el('p', { class: 'small muted' }, 'Candidatura única: o resultado mostra votos e abstenções. A aprovação segue o regimento da reunião.'));
  }

  const stat = (label, value) => el('div', {}, el('dt', {}, label), el('dd', {}, String(value)));
  const summary = compact
    ? null
    : el(
        'dl',
        { class: 'result-summary' },
        stat('Votos registrados', results.castVotes),
        stat('Válidos', results.validVotes),
        stat('Abstenções', results.abstentions),
        stat('Pessoas presentes', results.presentParticipants ?? results.expectedParticipants ?? '—'),
      );

  const root = el('div', { class: 'result' }, list, notes.length ? el('div', { class: 'result-notes' }, ...notes) : null, summary);
  const rows = [...list.querySelectorAll('.result-row')];
  if (animate && !prefersReducedMotion()) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const r of rows) r.querySelector('.bar-fill').style.width = `${r.dataset.pct}%`;
      }),
    );
  } else {
    for (const r of rows) {
      const f = r.querySelector('.bar-fill');
      f.style.transition = 'none';
      f.style.width = `${r.dataset.pct}%`;
    }
  }
  return root;
}

/** Estado vazio padronizado. */
export function emptyState({ iconName = 'inbox', title, text, action } = {}) {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty-icon' }, icon(iconName)),
    title ? el('p', { class: 'empty-title' }, title) : null,
    text ? el('p', { class: 'empty-text' }, text) : null,
    action || null,
  );
}
