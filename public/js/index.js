import {
  api,
  el,
  $,
  icon,
  storage,
  isMeetingId,
  registerServiceWorker,
  setupOfflineBar,
  adminUrl,
  serverMissing,
  STATUS_LABEL,
  emptyState,
  setText,
} from './common.js';

registerServiceWorker();
setupOfflineBar();

const params = new URLSearchParams(location.search);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let selected = isMeetingId(params.get('m')) ? params.get('m') : storage.lastMeeting();
let meetings = [];

// App instalado aberto com uma reunião já usada: vai direto para a votação.
if (standalone && isMeetingId(selected) && !params.has('home')) {
  location.replace(`votar.html?m=${encodeURIComponent(selected)}`);
}

$('#go-admin').href = adminUrl();

function setConn(kind, text) {
  const c = $('#conn');
  c.className = `chip ${kind}`;
  c.textContent = text;
}

function updateLinks() {
  const ok = isMeetingId(selected) && meetings.some((m) => m.id === selected);
  const q = ok ? `?m=${encodeURIComponent(selected)}` : '';
  $('#go-vote').href = `votar.html${q}`;
  $('#go-presentation').href = `apresentacao.html${q}`;
  for (const id of ['go-vote', 'go-presentation']) $(`#${id}`).toggleAttribute('data-needs-meeting', !ok);
  const m = meetings.find((x) => x.id === selected);
  setText('#picker-hint', m ? `Selecionada: ${m.name}.` : meetings.length ? 'Selecione uma reunião acima.' : '');
}

function select(id) {
  selected = id;
  storage.rememberMeeting(id);
  updateLinks();
}

// Sem reunião escolhida, os botões levam ao seletor em vez de abrir uma página vazia.
for (const id of ['go-vote', 'go-presentation']) {
  $(`#${id}`).addEventListener('click', (ev) => {
    if (!ev.currentTarget.hasAttribute('data-needs-meeting')) return;
    ev.preventDefault();
    setText('#picker-hint', meetings.length ? 'Escolha uma reunião para continuar.' : 'Ainda não há reunião disponível.');
    $('#picker').focus();
    $('#picker').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  });
}

function renderList() {
  const list = $('#meeting-list');
  list.removeAttribute('aria-busy');
  if (!meetings.length) {
    list.replaceChildren(
      emptyState({
        iconName: 'calendar',
        title: 'Nenhuma reunião disponível',
        text: 'O administrador deve criar uma reunião no Painel Administrativo. Ela aparecerá aqui automaticamente.',
        action: el('a', { class: 'btn btn-primary', href: adminUrl() }, icon('shield'), 'Abrir Painel Administrativo'),
      }),
    );
    return;
  }
  if (!meetings.some((m) => m.id === selected) && meetings.length === 1) selected = meetings[0].id;
  list.replaceChildren(
    ...meetings.map((m) => {
      const input = el('input', { type: 'radio', name: 'meeting', id: `mt-${m.id}`, value: m.id });
      input.checked = m.id === selected;
      input.addEventListener('change', () => select(m.id));
      return el(
        'div',
        { class: 'meeting-option' },
        input,
        el(
          'label',
          { for: `mt-${m.id}` },
          el('span', { class: 'meeting-name' }, m.name),
          el('span', { class: `chip ${m.phase}` }, STATUS_LABEL[m.phase] || m.phase),
        ),
      );
    }),
  );
  updateLinks();
}

async function load() {
  if (serverMissing) {
    setConn('offline', 'Servidor não configurado');
    const note = $('#server-note');
    note.replaceChildren(
      icon('alert'),
      el(
        'span',
        {},
        'Esta publicação estática ainda não está ligada ao servidor do NOMEIA. Informe a URL do servidor em js/config.js (veja o README, seção GitHub Pages).',
      ),
    );
    note.hidden = false;
    meetings = [];
    $('#meeting-list').replaceChildren(
      emptyState({ iconName: 'wifi-off', title: 'Servidor indisponível', text: 'As reuniões aparecem aqui quando o servidor estiver configurado.' }),
    );
    updateLinks();
    return;
  }
  try {
    meetings = await api('/api/meetings');
    setConn('online', 'Servidor conectado');
  } catch (e) {
    setConn('offline', 'Servidor indisponível');
    meetings = [];
    const retry = el('button', { class: 'btn btn-secondary', type: 'button' }, icon('refresh'), 'Tentar novamente');
    retry.addEventListener('click', load);
    $('#meeting-list').replaceChildren(emptyState({ iconName: 'wifi-off', title: 'Não foi possível carregar as reuniões', text: e.message, action: retry }));
    updateLinks();
    return;
  }
  renderList();
}

updateLinks();
load();
