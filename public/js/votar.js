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
  toast,
} from './common.js';

registerServiceWorker();
setupOfflineBar();

const ABSTAIN = 'abstain';
const params = new URLSearchParams(location.search);
let meetingId = params.get('m');
// O token chega no fragmento (#t=...), que não é enviado ao servidor nem fica em logs.
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('t');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

let state = null;
let me = null;
let credential = null;
let selection = null;
let sending = false;
let flash = null;
let currentOfficeId = null;
let viewKey = '';
let live = null;
let pendingOffice = null;
let lastResultsKey = '';
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('nomeia') : null;
const dialog = $('#confirm-dialog');

function show(view) {
  for (const id of ['view-loading', 'view-error', 'view-consent', 'view-main']) $(`#${id}`).hidden = id !== view;
}

function fatal(text) {
  setText('#error-text', text);
  show('view-error');
}

function bindMeeting(id) {
  meetingId = id;
  history.replaceState(null, '', `/votar.html?m=${encodeURIComponent(id)}`);
  // Manifesto vinculado à reunião: a PWA instalada a partir daqui abre direto nesta tela.
  $('link[rel="manifest"]').href = `/manifest.webmanifest?m=${encodeURIComponent(id)}`;
  storage.rememberMeeting(id);
}

function askConsent(info, raw) {
  return new Promise((resolve) => {
    setText('#consent-label', info.participant.label);
    setText('#consent-meeting', info.meetingName);
    show('view-consent');
    $('#consent-yes').focus();
    const done = (persist) => {
      storage.saveCredential(info.meetingId, raw, persist);
      $('#consent-yes').onclick = null;
      $('#consent-no').onclick = null;
      resolve();
    };
    $('#consent-yes').onclick = () => done(true);
    $('#consent-no').onclick = () => done(false);
  });
}

/** Valida uma credencial nova (link/QR ou código) e pede consentimento para guardá-la. */
async function adoptCredential(raw) {
  const info = await api('/api/credentials/check', { method: 'POST', credential: raw });
  if (storage.getCredential(info.meetingId) !== raw) await askConsent(info, raw);
  const switched = info.meetingId !== meetingId;
  bindMeeting(info.meetingId);
  credential = raw;
  me = info;
  return switched;
}

async function refreshMe() {
  if (!credential) return;
  try {
    me = await api('/api/credentials/check', { method: 'POST', credential });
    if (me.meetingId !== meetingId) throw Object.assign(new Error(), { code: 'invalid_credential' });
  } catch (e) {
    if (e.code === 'invalid_credential') {
      storage.forgetCredential(meetingId);
      credential = null;
      me = null;
      flash = { kind: 'warn', text: 'Sua credencial não é mais válida neste aparelho (pode ter sido reemitida). Use o cartão atualizado.' };
    }
    // Falha de rede: mantém o último estado conhecido; o servidor decide no envio.
  }
}

function hasVoted(o) {
  return Boolean(o && me && me.votedOfficeIds.includes(o.id));
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

/** Nomes ao vivo, sem interação (discussão ou participante sem credencial). */
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
      option(ABSTAIN, 'Abstenção', 'abstain', 'Registrar participação sem escolher um nome'),
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
  if (typeof dialog.showModal !== 'function') {
    const ok = await confirmDialog({ title: 'Confirmar voto', message: `Você escolheu: ${chosenName(o)}. O voto não poderá ser alterado.` });
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
  if (!sending) closeConfirm();
});
$('#confirm-btn').addEventListener('click', () => {
  if (pendingOffice) submitVote(pendingOffice);
});
dialog.addEventListener('cancel', (e) => {
  if (sending) e.preventDefault();
  else pendingOffice = null;
});

async function submitVote(o) {
  if (sending) return;
  sending = true;
  setConfirmBusy(true);
  let finished = true;
  let registered = false;
  try {
    await api(`/api/meetings/${encodeURIComponent(meetingId)}/votes`, {
      method: 'POST',
      credential,
      body: { officeId: o.id, choice: selection },
    });
    me.votedOfficeIds.push(o.id);
    flash = null;
    registered = true;
    announce('Seu voto foi registrado.', { assertive: true });
    bc?.postMessage({ type: 'voted', meetingId, officeId: o.id });
  } catch (e) {
    if (e.code === 'already_voted') {
      me.votedOfficeIds.push(o.id);
      flash = { kind: 'info', text: e.message };
    } else if (e.code === 'invalid_credential' || e.code === 'credential_revoked') {
      flash = { kind: 'error', text: e.message };
      await refreshMe();
    } else if (e.code === 'network_error' || e.status >= 500 || e.status === 429) {
      finished = false; // mantém a escolha para nova tentativa enquanto a votação estiver aberta
      flash = { kind: 'error', text: `${e.message} Seu voto NÃO foi registrado.` };
    } else {
      flash = { kind: 'error', text: e.message };
    }
    announce(flash.text, { assertive: true });
  } finally {
    sending = false;
    setConfirmBusy(false);
    closeConfirm();
    if (finished) selection = null;
    viewKey = '';
    render();
    if (registered) $('#office-area .voted')?.focus();
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

function buildOffice(o) {
  const area = [officeHeader(o)];
  if (o.status === 'discussing') {
    area.push(banner('info', 'Em discussão. A votação será liberada pela mesa; esta tela atualiza sozinha.'));
    area.push(candidateList(o));
    area.push(lockedActionBar('Votação ainda não aberta', credential ? 'Você poderá votar assim que a mesa abrir a votação.' : null));
  } else if (o.status === 'voting_open') {
    if (!credential) {
      area.push(banner('warn', 'Votação aberta. Para votar, use a credencial individual (cartão ou QR) entregue pela organização.'));
      area.push(candidateList(o));
    } else if (!me) {
      const retry = el('button', { class: 'btn btn-secondary', type: 'button' }, icon('refresh'), 'Tentar novamente');
      retry.addEventListener('click', async () => {
        await refreshMe();
        viewKey = '';
        render();
      });
      area.push(banner('warn', 'Não foi possível verificar sua credencial. Confira a conexão.'), retry);
    } else if (me.participant.revoked) {
      area.push(banner('error', 'Esta credencial foi revogada pela organização.'));
    } else if (hasVoted(o)) {
      area.push(
        el(
          'div',
          { class: 'voted', tabindex: '-1' },
          el('div', { class: 'voted-icon' }, icon('check')),
          el('h3', {}, 'Seu voto foi registrado'),
          el('p', { class: 'muted small' }, 'Obrigado. O voto é definitivo e não pode ser alterado.'),
          waitingNext(),
        ),
      );
    } else {
      area.push(voteForm(o));
    }
  } else if (o.status === 'closed') {
    area.push(banner('info', 'Votação encerrada.'));
    if (hasVoted(o)) area.push(banner('success', 'Seu voto neste cargo foi registrado.'));
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
    flash = null;
  }

  // Votação mudou enquanto o modal estava aberto (encerrada ou novo cargo).
  if (dialog.open && !sending && (!o || o.id !== pendingOffice?.id || o.status !== 'voting_open')) {
    closeConfirm();
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
    Boolean(credential),
    Boolean(me),
    me?.participant?.revoked,
    hasVoted(o),
    sending,
    flash,
    state.status === 'archived' ? state.history : null,
  ]);
  if (key !== viewKey) {
    viewKey = key;
    const area = $('#office-area');
    const nodes =
      state.status === 'archived'
        ? buildArchived()
        : o
          ? buildOffice(o)
          : [emptyState({ iconName: 'clock', title: 'Aguardando o primeiro cargo', text: 'Assim que a mesa apresentar o cargo, os nomes aparecem aqui automaticamente.' })];
    area.replaceChildren(...nodes);
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
    turnout.replaceChildren(icon('users'), el('span', {}, `${plural(o.turnout.voted, 'voto registrado', 'votos registrados')} de ${o.turnout.expected} participantes previstos`));
  } else turnout.replaceChildren();

  $('#code-area').hidden = Boolean(credential) || state.status === 'archived';
  $('#identity').hidden = !credential || !me;
  if (me) setText('#identity-label', me.participant.label);
}

function startLive() {
  live?.close();
  live = connectLive({
    meetingId,
    onState: async (s, type) => {
      state = s;
      announceEvent(type, s);
      render();
      if (credential && ['snapshot', 'vote_opened', 'next_office'].includes(type)) {
        await refreshMe();
        viewKey = '';
        render();
      }
    },
    onStatus: (st) => statusChip($('#conn'), st),
    onFatal: (reason) => fatal(reason === 'not_found' ? 'Reunião não encontrada. Confira o link ou o QR Code.' : 'Acesso negado.'),
  });
}

$('#code-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const raw = $('#code-input').value.trim();
  if (!raw) return;
  const btn = ev.submitter || $('#code-form button');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const switched = await adoptCredential(raw);
    $('#code-input').value = '';
    flash = null;
    viewKey = '';
    show('view-main');
    if (switched) startLive();
    else render();
    toast('Credencial reconhecida.');
  } catch (e) {
    show('view-main');
    flash = { kind: 'error', text: e.code === 'invalid_credential' ? 'Código não reconhecido. Confira e tente novamente.' : e.message };
    viewKey = '';
    render();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
});

$('#forget').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Esquecer credencial?',
    message: 'A credencial será apagada deste aparelho. Para votar de novo será preciso ler o QR ou digitar o código do cartão.',
    confirmLabel: 'Esquecer',
    danger: true,
  });
  if (!ok) return;
  storage.forgetCredential(meetingId);
  credential = null;
  me = null;
  viewKey = '';
  render();
  toast('Credencial removida deste aparelho.', 'info');
});

bc?.addEventListener('message', async (ev) => {
  if (ev.data?.type === 'voted' && ev.data.meetingId === meetingId) {
    await refreshMe();
    viewKey = '';
    render();
  }
});

async function init() {
  if (fragmentToken) {
    try {
      await adoptCredential(fragmentToken);
    } catch (e) {
      flash = {
        kind: 'error',
        text: e.code === 'invalid_credential' ? 'Esta credencial não é válida (pode ter sido reemitida ou revogada).' : e.message,
      };
    }
  }
  if (!isMeetingId(meetingId)) meetingId = storage.lastMeeting();
  if (!isMeetingId(meetingId)) {
    location.replace('/index.html');
    return;
  }
  bindMeeting(meetingId);
  if (!credential) {
    credential = storage.getCredential(meetingId);
    if (credential) await refreshMe();
  }
  startLive();
}

init();
