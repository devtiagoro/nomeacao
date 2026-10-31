import { el, $, setText, announce, statusChip, renderResults, STATUS_LABEL, plural, icon, emptyState } from './common.js';
import { configured, castBallot, watchMeeting, watchConnection, watchCurrent } from './db.js';
import { ABSTAIN, ballotChoices, newRequestId } from './domain.js';

// Votação pública: sem login, sem código. Cada "Confirmar voto" registra uma cédula.
// A tela segue a reunião em andamento: próximo cargo e nova reunião aparecem sozinhos.

let meetingId = null;
let stopMeeting = null;
let state = null;
let currentOfficeId = null;
let selection = new Set();
let sending = false;
let flash = null;
let justVoted = null; // cargo em que esta tela acabou de votar (somente memória; não limita novos votos)
let pendingRequestId = null; // reaproveitado apenas para reenviar após falha de rede
const attempted = new Set();
let viewKey = '';
let resultsKey = '';

const FLASH_ICON = { error: 'alert', warn: 'alert', info: 'info', success: 'check-circle' };

function banner(kind, text) {
  return el('p', { class: `banner ${kind}` }, icon(FLASH_ICON[kind] || 'info'), el('span', {}, text));
}

function waiting(text) {
  return el('p', { class: 'waiting' }, el('span', { class: 'waiting-dot', 'aria-hidden': 'true' }), text);
}

function officeHeader(o) {
  const type = o.voteType === 'multiple' ? `Escolha até ${o.maxChoices} nomes` : 'Escolha um nome';
  return el(
    'header',
    { class: 'office-hero' },
    el('div', { class: 'office-hero-top' }, el('span', { class: 'eyebrow' }, type), el('span', { class: `chip ${o.status}` }, STATUS_LABEL[o.status])),
    el('h2', {}, o.title),
  );
}

/** Nomes ao vivo, sem interação (cargo apresentado, votação ainda fechada). */
function candidateList(o) {
  if (!o.candidates.length) return emptyState({ iconName: 'users', title: 'Nenhum nome proposto ainda', text: 'Os nomes aparecem aqui assim que forem adicionados.' });
  return el(
    'ul',
    { class: 'choice-list', 'aria-label': 'Nomes propostos' },
    o.candidates.map((c, i) => el('li', { class: 'choice-static' }, el('span', { class: 'choice-index', 'aria-hidden': 'true' }, String(i + 1)), el('span', {}, c.name))),
  );
}

function voteForm(o) {
  const multiple = o.voteType === 'multiple';
  const submit = el('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Confirmar voto');
  const hint = el('p', { class: 'action-hint', id: 'vote-hint' });
  const inputs = [];

  const sync = () => {
    const names = [...selection].filter((v) => v !== ABSTAIN).length;
    submit.disabled = !selection.size;
    for (const i of inputs) i.checked = selection.has(i.value);
    if (multiple) for (const i of inputs) i.disabled = i.value !== ABSTAIN && !i.checked && names >= o.maxChoices;
    hint.textContent = !selection.size
      ? 'Toque em uma opção.'
      : multiple && !selection.has(ABSTAIN)
        ? `${names} de até ${o.maxChoices} selecionados.`
        : 'Toque em "Confirmar voto" para registrar.';
  };

  const option = (value, label, extraClass = '', sub = '') => {
    const id = `opt-${value}`;
    const input = el('input', { type: multiple ? 'checkbox' : 'radio', name: 'vote', id, value });
    inputs.push(input);
    input.addEventListener('change', () => {
      if (!multiple) selection = new Set([value]);
      else if (!input.checked) selection.delete(value);
      else if (value === ABSTAIN) selection = new Set([ABSTAIN]);
      else {
        selection.delete(ABSTAIN);
        selection.add(value);
      }
      sync();
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
      el('legend', {}, multiple ? `Escolha até ${o.maxChoices} nomes` : 'Escolha um nome'),
      o.candidates.map((c) => option(c.id, c.name)),
      el('div', { class: 'options-divider', 'aria-hidden': 'true' }, 'ou'),
      option(ABSTAIN, 'Abstenção', 'abstain', 'Registrar o voto sem escolher um nome'),
    ),
    el('div', { class: 'action-bar' }, submit, hint),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (selection.size) submitVote(o, submit);
  });
  sync();
  return form;
}

async function submitVote(o, button) {
  if (sending) return;
  let choices;
  try {
    choices = ballotChoices(o, [...selection]);
  } catch (e) {
    flash = { kind: 'error', text: e.message };
    return render(true);
  }
  sending = true;
  button.disabled = true;
  button.textContent = 'Registrando…';
  pendingRequestId ??= newRequestId();
  const requestId = pendingRequestId;
  try {
    const retry = attempted.has(requestId);
    attempted.add(requestId);
    try {
      await castBallot(meetingId, o.id, choices, requestId);
    } catch (e) {
      // Reenvio recusado com a votação ainda aberta: a tentativa anterior já tinha sido
      // registrada (falhou só a resposta). Não conta de novo.
      const stillOpen = state?.currentOffice?.id === o.id && state.currentOffice.status === 'voting_open';
      if (!(e.code === 'rejected' && retry && stillOpen)) throw e;
    }
    justVoted = o.id;
    flash = null;
    pendingRequestId = null;
    selection = new Set();
    announce('Voto registrado.', { assertive: true });
  } catch (e) {
    // Falha de rede: mantém a escolha e o identificador; ao tentar de novo o banco reconhece se já registrou.
    if (e.code !== 'network_error') {
      pendingRequestId = null;
      selection = new Set();
    }
    flash = { kind: 'error', text: e.code === 'network_error' ? `${e.message} Toque em "Confirmar voto" novamente.` : e.message };
    announce(flash.text, { assertive: true });
  } finally {
    sending = false;
    render(true);
    if (justVoted) $('#office-area .voted')?.focus();
  }
}

function votedPanel() {
  const again = el('button', { class: 'btn btn-secondary btn-lg', type: 'button' }, icon('refresh'), 'Votar novamente');
  again.addEventListener('click', () => {
    justVoted = null;
    render(true);
    $('#office-area input')?.focus();
  });
  return el(
    'div',
    { class: 'voted', tabindex: '-1' },
    el('div', { class: 'voted-icon' }, icon('check')),
    el('h3', {}, 'Voto registrado'),
    waiting('Aguarde o encerramento da votação'),
    again,
  );
}

function buildOffice(o) {
  const area = [officeHeader(o)];
  if (o.status === 'discussing') {
    area.push(candidateList(o), waiting('A votação ainda não foi aberta'));
  } else if (o.status === 'voting_open') {
    area.push(justVoted === o.id ? votedPanel() : voteForm(o));
    if (o.liveResults) area.push(el('div', { id: 'results-slot' }));
  } else {
    area.push(el('div', { id: 'results-slot' }), waiting('Aguardando o próximo cargo'));
  }
  return area;
}

function render(force = false) {
  if (!state) return;
  setText('#meeting-name', state.name);
  document.title = `${state.name} — Nomeia`;
  const o = state.currentOffice;

  if (o?.id !== currentOfficeId) {
    currentOfficeId = o?.id ?? null;
    selection = new Set();
    pendingRequestId = null;
    justVoted = null;
    flash = null;
  }

  // Durante o voto a tela só é reconstruída quando algo relevante muda (preserva a seleção).
  const key = JSON.stringify([o?.id, o?.status, o?.title, o?.candidates, o?.voteType, o?.maxChoices, o?.liveResults, justVoted, flash]);
  if (force || key !== viewKey) {
    viewKey = key;
    resultsKey = '';
    $('#office-area').replaceChildren(...(o ? buildOffice(o) : [emptyState({ iconName: 'clock', title: 'Aguardando o próximo cargo', text: 'Esta tela atualiza sozinha.' })]));
    $('#flash').replaceChildren(flash ? banner(flash.kind, flash.text) : '');
  }

  const slot = $('#results-slot');
  if (slot) {
    const rk = JSON.stringify(o.result);
    if (rk !== resultsKey) {
      const first = !resultsKey;
      resultsKey = rk;
      slot.replaceChildren(
        o.result
          ? el('section', { class: 'card' }, el('h3', { class: 'mb-4' }, o.status === 'closed' ? 'Resultado' : 'Resultado parcial'), renderResults(o.result, { animate: first }))
          : waiting('Apurando…'),
      );
    }
  }
  const turnout = $('#turnout');
  if (o?.status === 'voting_open') turnout.replaceChildren(icon('ballot'), el('span', {}, `${plural(o.ballots, 'voto registrado', 'votos registrados')}`));
  else turnout.replaceChildren();
}

function noMeeting() {
  state = null;
  setText('#meeting-name', 'Nomeia');
  $('#office-area').replaceChildren(emptyState({ iconName: 'clock', title: 'Aguardando o início da reunião', text: 'Esta tela atualiza sozinha.' }));
  $('#turnout').replaceChildren();
}

function unavailable() {
  setText('#meeting-name', 'Nomeia');
  $('#office-area').replaceChildren(emptyState({ iconName: 'wifi-off', title: 'Votação indisponível no momento', text: 'Tente novamente em instantes.' }));
}

async function follow(id) {
  stopMeeting?.();
  stopMeeting = null;
  meetingId = id;
  viewKey = '';
  if (!id) return noMeeting();
  const stop = await watchMeeting(id, {}, (s) => {
    if (meetingId !== id) return;
    state = s;
    render();
  }, noMeeting);
  if (meetingId === id) stopMeeting = stop;
  else stop();
}

if (!configured) unavailable();
else {
  watchConnection((st) => statusChip($('#conn'), st))
    .then(() => watchCurrent(follow))
    .catch(unavailable);
}
