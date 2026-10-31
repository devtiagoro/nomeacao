import {
  api,
  el,
  $,
  setText,
  announce,
  connectLive,
  storage,
  isMeetingId,
  setupOfflineBar,
  registerServiceWorker,
  statusChip,
  renderResults,
  STATUS_LABEL,
  plural,
  icon,
  emptyState,
  confirmDialog,
} from './common.js';

registerServiceWorker();
setupOfflineBar();

// Votação pública: sem login, sem credencial. Cada confirmação registra um voto.
const ABSTAIN = 'abstain';
let meetingId = new URLSearchParams(location.search).get('m');

let state = null;
let selection = null;
let sending = false;
let flash = null;
let currentOfficeId = null;
let viewKey = '';
let pendingOffice = null;
let pendingRequestId = null; // id da confirmação em andamento (reaproveitado só em reenvio após falha)
let lastResultsKey = '';
// Confirmação recém-registrada nesta tela (somente memória; não limita novos votos).
let justVoted = null;
const dialog = $('#confirm-dialog');

function show(view) {
  for (const id of ['view-loading', 'view-error', 'view-main']) $(`#${id}`).hidden = id !== view;
}

function fatal(text) {
  setText('#error-text', text);
  show('view-error');
}

/** Identificador aleatório de uma confirmação (funciona também fora de HTTPS). */
function newRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bindMeeting(id) {
  meetingId = id;
  history.replaceState(null, '', `votar.html?m=${encodeURIComponent(id)}`);
  // Manifesto vinculado à reunião (quando servido pelo Node): a PWA instalada abre nesta tela.
  $('link[rel="manifest"]').href = `manifest.webmanifest?m=${encodeURIComponent(id)}`;
  storage.rememberMeeting(id);
}

function announceEvent(type, s) {
  const o = s.currentOffice;
  const msgs = {
    vote_opened: o && `Votação aberta para ${o.title}.`,
    next_office: o && `Novo cargo em discussão: ${o.title}.`,
    candidates_updated: 'Lista de nomes atualizada.',
    vote_closed: 'Votação encerrada.',
    results_published: 'Resultados publicados.',
    meeting_closed: 'Reunião encerrada.',
  };
  if (msgs[type]) announce(msgs[type], { assertive: type === 'vote_opened' });
}

// ---------------- Componentes de tela ----------------

const FLASH_ICON = { error: 'alert', warn: 'alert', info: 'info', success: 'check-circle' };

function banner(kind, text) {
  return el('p', { class: `banner ${kind}` }, icon(FLASH_ICON[kind] || 'info'), el('span', {}, text));
}

/** Nomes ao vivo, sem interação (durante a discussão). */
function candidateList(o) {
  if (!o.candidates.length) {
    return emptyState({ iconName: 'users', title: 'Nenhum nome indicado ainda', text: 'Os nomes aparecem aqui assim que a mesa os adicionar.' });
  }
  return el(
    'ul',
    { class: 'choice-list candidate-list', 'aria-label': 'Nomes indicados' },
    o.candidates.map((c, i) => el('li', { class: 'choice-static' }, el('span', { class: 'choice-index', 'aria-hidden': 'true' }, String(i + 1)), el('span', {}, c.name))),
  );
}

function lockedActionBar(text, hint) {
  const btn = el('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', disabled: true, 'aria-disabled': 'true' }, icon('lock'), text);
  return el('div', { class: 'action-bar' }, btn, hint ? el('p', { class: 'action-hint' }, hint) : null);
}

function voteForm(o) {
  const name = `vote-${o.id}`;
  const submit = el('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Confirmar meu voto');
  const hint = el('p', { class: 'action-hint', id: 'vote-hint' }, selection ? 'Você revisará sua escolha antes de registrar.' : 'Toque em uma opção para continuar.');
  submit.disabled = !selection;
  const option = (value, label, extraClass = '', sub = '') => {
    const id = `opt-${value}`;
    const input = el('input', { type: 'radio', name, id, value });
    input.checked = selection === value;
    input.addEventListener('change', () => {
      selection = value;
      submit.disabled = false;
      hint.textContent = 'Você revisará sua escolha antes de registrar.';
    });
    return el(
      'div',
      { class: `option ${extraClass}`.trim() },
      input,
      el(
        'label',
        { for: id },
        el('span', { class: 'option-radio', 'aria-hidden': 'true' }, icon('check')),
        el('span', { class: 'option-name' }, label, sub ? el('span', { class: 'option-hint' }, sub) : null),
      ),
    );
  };
  const form = el(
    'form',
    { class: 'vote-form', novalidate: true, 'aria-describedby': 'vote-hint' },
    el(
      'fieldset',
      { class: 'options' },
      el('legend', {}, 'Escolha uma opção'),
      o.candidates.map((c) => option(c.id, c.name)),
      el('div', { class: 'options-divider', 'aria-hidden': 'true' }, 'ou'),
      option(ABSTAIN, 'Abstenção', 'abstain', 'Registrar o voto sem escolher um nome'),
    ),
    el('div', { class: 'action-bar' }, submit, hint),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (selection) openConfirm(o);
  });
  return form;
}

function chosenName(o) {
  return selection === ABSTAIN ? 'Abstenção' : o.candidates.find((c) => c.id === selection)?.name || '—';
}

/** Modal de confirmação com o nome escolhido antes de registrar. */
async function openConfirm(o) {
  pendingOffice = o;
  // Nova confirmação = novo voto. Só um reenvio após falha reaproveita o id anterior.
  if (!pendingRequestId) pendingRequestId = newRequestId();
  if (typeof dialog.showModal !== 'function') {
    const ok = await confirmDialog({ title: 'Confirmar voto', message: `Você escolheu: ${chosenName(o)}.` });
    if (ok) submitVote(o);
    return;
  }
  setText('#confirm-choice', chosenName(o));
  setConfirmBusy(false);
  dialog.showModal();
  $('#confirm-btn').focus();
}

function setConfirmBusy(busy) {
  const ok = $('#confirm-btn');
  ok.disabled = busy;
  $('#confirm-cancel').disabled = busy;
  if (busy) ok.setAttribute('aria-busy', 'true');
  else ok.removeAttribute('aria-busy');
  ok.textContent = busy ? 'Registrando…' : 'Confirmar voto';
}

function closeConfirm() {
  if (dialog.open) dialog.close();
  pendingOffice = null;
}

$('#confirm-cancel').addEventListener('click', () => {
  if (!sending) {
    pendingRequestId = null;
    closeConfirm();
  }
});
// Duplo clique: o botão é desativado no primeiro clique e "sending" ignora o segundo.
$('#confirm-btn').addEventListener('click', () => {
  if (pendingOffice) submitVote(pendingOffice);
});
dialog.addEventListener('cancel', (e) => {
  if (sending) e.preventDefault();
  else {
    pendingOffice = null;
    pendingRequestId = null;
  }
});

async function submitVote(o) {
  if (sending) return;
  sending = true;
  setConfirmBusy(true);
  const requestId = pendingRequestId || newRequestId();
  pendingRequestId = requestId;
  let keepChoice = false;
  try {
    await api(`/api/meetings/${encodeURIComponent(meetingId)}/votes`, {
      method: 'POST',
      body: { officeId: o.id, choice: selection, requestId },
    });
    justVoted = { officeId: o.id, name: chosenName(o) };
    flash = null;
    pendingRequestId = null;
    announce('Seu voto foi registrado.', { assertive: true });
  } catch (e) {
    if (e.code === 'network_error' || e.status >= 500 || e.status === 429) {
      // Mantém escolha e requestId: ao tentar de novo, o servidor reconhece se já tinha registrado.
      keepChoice = true;
      flash = { kind: 'error', text: `${e.message} Toque em "Confirmar meu voto" para tentar novamente.` };
    } else {
      pendingRequestId = null;
      flash = { kind: 'error', text: e.message };
    }
    announce(flash.text, { assertive: true });
  } finally {
    sending = false;
    setConfirmBusy(false);
    closeConfirm();
    if (!keepChoice) selection = null;
    viewKey = '';
    render();
    if (justVoted) $('#office-area .voted')?.focus();
  }
}

function officeHeader(o) {
  return el(
    'header',
    { class: 'office-hero' },
    el('div', { class: 'office-hero-top' }, el('span', { class: 'eyebrow' }, 'Cargo atual'), el('span', { class: `chip ${o.status}` }, STATUS_LABEL[o.status] || o.status)),
    el('h2', {}, o.title),
    o.description ? el('p', {}, o.description) : null,
  );
}

function waitingNext() {
  return el('p', { class: 'waiting' }, el('span', { class: 'waiting-dot', 'aria-hidden': 'true' }), 'Aguardando o próximo cargo');
}

function votedPanel() {
  const again = el('button', { class: 'btn btn-secondary btn-lg', type: 'button' }, icon('refresh'), 'Votar novamente');
  again.addEventListener('click', () => {
    justVoted = null;
    viewKey = '';
    render();
    $('#office-area input[type=radio]')?.focus();
  });
  return el(
    'div',
    { class: 'voted', tabindex: '-1' },
    el('div', { class: 'voted-icon' }, icon('check')),
    el('h3', {}, 'Seu voto foi registrado'),
    el('p', { class: 'muted small' }, `Opção: ${justVoted.name}`),
    waitingNext(),
    again,
  );
}

function buildOffice(o) {
  const area = [officeHeader(o)];
  if (o.status === 'discussing') {
    area.push(banner('info', 'Em discussão. A votação será liberada pela mesa; esta tela atualiza sozinha.'));
    area.push(candidateList(o));
    area.push(lockedActionBar('Votação ainda não aberta', 'Você poderá votar assim que a mesa abrir a votação.'));
  } else if (o.status === 'voting_open') {
    area.push(justVoted?.officeId === o.id ? votedPanel() : voteForm(o));
  } else if (o.status === 'closed') {
    area.push(banner('info', 'Votação encerrada.'));
    area.push(el('div', { id: 'results-slot' }));
    area.push(waitingNext());
  }
  if (o.status === 'voting_open' && o.resultsMode === 'live') area.push(el('div', { id: 'results-slot' }));
  return area;
}

function buildArchived() {
  const items = state.history.map((h) =>
    el(
      'section',
      { class: 'card' },
      el('h3', { class: 'mb-4' }, h.title),
      h.results ? renderResults(h.results) : el('p', { class: 'muted small' }, 'Resultado não divulgado.'),
    ),
  );
  return [emptyState({ iconName: 'check-circle', title: 'Reunião encerrada', text: 'Obrigado pela participação.' }), ...items];
}

function render() {
  if (!state) return;
  show('view-main');
  setText('#meeting-name', state.name);
  document.title = `${state.name} — Nomeia`;
  const o = state.currentOffice;

  if (o?.id !== currentOfficeId) {
    currentOfficeId = o?.id ?? null;
    selection = null;
    pendingRequestId = null;
    justVoted = null;
    flash = null;
  }

  // Votação mudou enquanto o modal estava aberto (encerrada ou novo cargo).
  if (dialog.open && !sending && (!o || o.id !== pendingOffice?.id || o.status !== 'voting_open')) {
    closeConfirm();
    pendingRequestId = null;
    flash = { kind: 'warn', text: 'A votação mudou antes da confirmação. Seu voto não foi registrado.' };
  }

  const key = JSON.stringify([
    state.status,
    o?.id,
    o?.status,
    o?.title,
    o?.description,
    o?.candidates,
    o?.resultsMode,
    justVoted,
    sending,
    flash,
    state.status === 'archived' ? state.history : null,
  ]);
  if (key !== viewKey) {
    viewKey = key;
    const nodes =
      state.status === 'archived'
        ? buildArchived()
        : o
          ? buildOffice(o)
          : [emptyState({ iconName: 'clock', title: 'Aguardando o primeiro cargo', text: 'Assim que a mesa apresentar o cargo, os nomes aparecem aqui automaticamente.' })];
    $('#office-area').replaceChildren(...nodes);
    $('#flash').replaceChildren(flash ? banner(flash.kind, flash.text) : '');
    lastResultsKey = '';
  }

  // Partes que mudam a cada voto são atualizadas sem reconstruir o formulário.
  const slot = $('#results-slot');
  if (slot) {
    const rk = JSON.stringify(o?.results);
    if (rk !== lastResultsKey) {
      const first = !lastResultsKey;
      lastResultsKey = rk;
      slot.replaceChildren(
        o?.results
          ? el('section', { class: 'card' }, el('h3', { class: 'mb-4' }, o.status === 'closed' ? 'Resultado' : 'Apuração parcial'), renderResults(o.results, { animate: first }))
          : banner('info', 'O resultado será divulgado pela mesa.'),
      );
    }
  }
  const turnout = $('#turnout');
  if (o && o.status === 'voting_open') {
    turnout.replaceChildren(icon('ballot'), el('span', {}, `${plural(o.turnout.votes, 'voto recebido', 'votos recebidos')} até agora`));
  } else turnout.replaceChildren();
}

function startLive() {
  connectLive({
    meetingId,
    onState: (s, type) => {
      state = s;
      announceEvent(type, s);
      render();
    },
    onStatus: (st) => statusChip($('#conn'), st),
    onFatal: (reason) =>
      fatal(
        reason === 'not_found'
          ? 'Reunião não encontrada. Confira o link ou o QR Code.'
          : reason === 'server_not_configured'
            ? 'Esta publicação ainda não está ligada a um servidor do NOMEIA.'
            : 'Acesso negado.',
      ),
  });
}

function init() {
  if (!isMeetingId(meetingId)) meetingId = storage.lastMeeting();
  if (!isMeetingId(meetingId)) {
    // Sem reunião escolhida: a página inicial lista as reuniões disponíveis.
    location.replace('index.html');
    return;
  }
  bindMeeting(meetingId);
  startLive();
}

init();
