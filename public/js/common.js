// NOMEIA — utilidades compartilhadas (ES module, sem dependências).
// Todo texto vindo do servidor é inserido via textContent (nunca innerHTML) para evitar XSS.
// Caminhos relativos: funciona em subpastas (GitHub Pages). Dados: js/db.js (Firebase).

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
  draft: 'Em preparação',
  discussing: 'Apresentado',
  voting_open: 'Votação aberta',
  closed: 'Encerrado',
};

export function fmtPct(n) {
  return `${Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

export function fmtDate(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Indicador de conexão com o banco (tempo real). */
export function statusChip(node, status) {
  const labels = { online: 'Ao vivo', offline: 'Reconectando…', connecting: 'Conectando…' };
  node.className = `chip ${status}`;
  node.textContent = labels[status] || status;
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
  monitor: ['r:3,4,18,12,2', 'p:M8 20h8', 'p:M12 16v4'],
  history: ['p:M3 12a9 9 0 1 0 3-6.7L3 8', 'p:M3 3v5h5', 'p:M12 7v5l3 2'],
  users: ['c:9,8,3.5', 'p:M2.5 20a6.5 6.5 0 0 1 13 0', 'p:M16 4.6a3.5 3.5 0 0 1 0 6.8', 'p:M21.5 20a6.5 6.5 0 0 0-4-6'],
  download: ['p:M12 4v11', 'p:m7 10 5 5 5-5', 'p:M5 20h14'],
  copy: ['r:9,9,12,12,2', 'p:M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  qr: ['r:3,3,7,7,1', 'r:14,3,7,7,1', 'r:3,14,7,7,1', 'p:M14 14h3v3h-3z', 'p:M20 14v.01', 'p:M14 20h.01', 'p:M17 20h3v-3'],
  logout: ['p:M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'p:m10 17-5-5 5-5', 'p:M5 12h11'],
  alert: ['p:M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'p:M12 9v4', 'p:M12 17h.01'],
  info: ['c:12,12,9', 'p:M12 16v-4', 'p:M12 8h.01'],
  'wifi-off': ['p:m2 2 20 20', 'p:M8.5 16.4a5 5 0 0 1 7 0', 'p:M5 12.8a10 10 0 0 1 5.2-2.7', 'p:M19 12.8a10 10 0 0 0-2.3-1.6', 'p:M2 9a15 15 0 0 1 4.3-2.6', 'p:M22 9a15 15 0 0 0-10.4-4', 'p:M12 20h.01'],
  ballot: ['r:4,3,16,18,2', 'p:m8.5 11.5 2.5 2.5 4.5-5', 'p:M8 17h8'],
  chart: ['p:M4 20h16', 'r:6,11,3,6,0.5', 'r:11,6,3,11,0.5', 'r:16,9,3,8,0.5'],
  shield: ['p:M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z', 'p:m9 12 2 2 4-4'],
  maximize: ['p:M4 9V4h5', 'p:M20 9V4h-5', 'p:M4 15v5h5', 'p:M20 15v5h-5'],
  refresh: ['p:M20 11a8 8 0 0 0-14.9-3.5L3 10', 'p:M3 4v6h6', 'p:M4 13a8 8 0 0 0 14.9 3.5L21 14', 'p:M21 20v-6h-6'],
  clock: ['c:12,12,9', 'p:M12 7v5l3 2'],
  calendar: ['r:3,5,18,16,2', 'p:M3 10h18', 'p:M8 3v4', 'p:M16 3v4'],
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
 * Resultado completo: todos os candidatos (inclusive com zero votos), abstenções separadas
 * e resumo. Percentual = votos ÷ cédulas válidas (na múltipla escolha a soma passa de 100%).
 * Nunca declara eleito: na escolha única indica o mais votado ou o empate.
 * animate=true anima as barras a partir de zero (respeita prefers-reduced-motion).
 */
export function renderResults(results, { animate = false } = {}) {
  const single = results.voteType !== 'multiple';
  const leaders = new Set(single ? results.leaders : []);
  const sorted = [...results.candidates].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'pt-BR'));
  const list = el('ol', { class: 'results', 'aria-label': 'Resultado por candidato' });
  for (const c of sorted) {
    const isLeader = leaders.has(c.id);
    const badges = isLeader ? [el('span', { class: `result-badge${results.tie ? ' tie' : ''}` }, results.tie ? 'Empate' : 'Mais votado')] : [];
    list.append(barRow({ name: c.name, votes: c.votes, pct: c.pct, pctLabel: 'das cédulas válidas', className: isLeader ? 'is-leader' : '', badges }));
  }
  const abstPct = results.ballots ? Math.round((results.abstentions * 10000) / results.ballots) / 100 : 0;
  list.append(barRow({ name: 'Abstenções', votes: results.abstentions, pct: abstPct, pctLabel: 'das cédulas', className: 'is-abstain' }));

  const notes = [];
  if (!results.ballots) notes.push(el('p', { class: 'banner info' }, icon('info'), el('span', {}, 'Nenhum voto registrado.')));
  else if (single && results.tie) {
    const names = results.candidates.filter((c) => leaders.has(c.id)).map((c) => c.name);
    notes.push(el('p', { class: 'banner warn' }, icon('alert'), el('span', {}, `Empate entre ${names.join(' e ')}, com ${plural(results.maxVotes, 'voto', 'votos')} cada.`)));
  }
  if (!single) notes.push(el('p', { class: 'small muted' }, `Múltipla escolha: até ${results.maxChoices} nomes por cédula; a soma dos percentuais pode passar de 100%.`));

  const stat = (label, value) => el('div', {}, el('dt', {}, label), el('dd', {}, String(value)));
  const summary = el(
    'dl',
    { class: 'result-summary' },
    stat('Cédulas', results.ballots),
    stat('Abstenções', results.abstentions),
    single ? null : stat('Votos em nomes', results.totalVotes),
    stat('Presentes', results.present ?? '—'),
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
