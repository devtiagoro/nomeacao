import { el, $, setText, announce, statusChip, renderResults, STATUS_LABEL, icon } from './common.js';
import { configured, watchMeeting, watchConnection, watchCurrent, qrDataUrl, pageUrl } from './db.js';

// Telão: segue a reunião em andamento e o cargo atual, sem interação.

let meetingId = null;
let stopMeeting = null;
let lastOfficeId = null;
let lastStatus = null;
let candidatesKey = '';
let resultsKey = '';
let resultsShownFor = null;

const STATUS_LINE = {
  discussing: ['users', 'A votação ainda não foi aberta.'],
  voting_open: ['ballot', 'Votação aberta — leia o QR Code e vote pelo celular.'],
  closed: ['lock', 'Votação encerrada.'],
};

/** Visão do palco: waiting | discussing | voting | closed | results. */
function viewOf(o) {
  if (!o) return 'waiting';
  if (o.status === 'discussing') return 'discussing';
  if (o.status === 'voting_open') return 'voting';
  return o.result ? 'results' : 'closed';
}

function showWaiting(title, name = '') {
  $('#stage').dataset.view = 'waiting';
  setText('#meeting-name', name);
  setText('#office-title', title);
  setText('#office-desc', 'Leia o QR Code para votar pelo celular.');
  for (const id of ['#office-status', '#status-line', '#candidates', '#results']) $(id).replaceChildren();
  candidatesKey = resultsKey = '';
}

function render(s) {
  const o = s.currentOffice;
  $('#stage').dataset.view = viewOf(o);
  setText('#meeting-name', s.name);
  document.title = `${s.name} — Apresentação`;
  if (!o) return showWaiting('Aguardando o próximo cargo', s.name);

  setText('#office-title', o.title);
  setText('#office-desc', o.voteType === 'multiple' ? `Múltipla escolha · até ${o.maxChoices} nomes por cédula` : 'Escolha única');
  $('#office-status').replaceChildren(el('span', { class: `chip ${o.status}` }, STATUS_LABEL[o.status]));
  const [ic, text] = STATUS_LINE[o.status] || [];
  $('#status-line').replaceChildren(icon(ic), el('span', {}, o.status === 'closed' && o.result ? 'Resultado final' : text));

  // Nomes propostos (dão lugar ao resultado quando ele é exibido)
  const showCandidates = !o.result;
  const ck = JSON.stringify([showCandidates, o.candidates]);
  if (ck !== candidatesKey) {
    candidatesKey = ck;
    $('#candidates').replaceChildren(
      showCandidates
        ? o.candidates.length
          ? el(
              'ul',
              { class: 'stage-candidates', 'aria-label': 'Nomes propostos' },
              o.candidates.map((c, i) => el('li', {}, el('span', { class: 'idx', 'aria-hidden': 'true' }, String(i + 1)), el('span', {}, c.name))),
            )
          : el('p', { class: 'stage-empty' }, 'Nenhum nome proposto ainda.')
        : '',
    );
  }

  // Resultado: parcial (se liberado) ou final; animado na primeira exibição de cada cargo
  const rk = JSON.stringify([o.id, o.result]);
  if (rk !== resultsKey) {
    resultsKey = rk;
    let node = '';
    if (o.result) {
      const first = resultsShownFor !== o.id;
      resultsShownFor = o.id;
      node = el('section', { class: 'stage-results' }, el('h3', {}, o.status === 'closed' ? 'Resultado' : 'Resultado parcial'), renderResults(o.result, { animate: first }));
    }
    $('#results').replaceChildren(node);
  }

  setText('#t-voted', o.ballots);
  setText('#t-expected', s.expectedParticipants);
  $('#turnout-card').hidden = o.status === 'discussing';

  if (o.id !== lastOfficeId) announce(`Cargo: ${o.title}.`);
  else if (o.status !== lastStatus) announce(STATUS_LINE[o.status]?.[1] || '');
  lastOfficeId = o.id;
  lastStatus = o.status;
}

async function follow(id) {
  stopMeeting?.();
  stopMeeting = null;
  meetingId = id;
  if (!id) return showWaiting('Aguardando o início da reunião');
  const stop = await watchMeeting(id, {}, (s) => meetingId === id && render(s), () => showWaiting('Aguardando o início da reunião'));
  if (meetingId === id) stopMeeting = stop;
  else stop();
}

// O link público é a tela de votação no próprio endereço publicado (ex.: GitHub Pages).
const publicUrl = pageUrl('votar.html');
setText('#public-link', publicUrl);
qrDataUrl(publicUrl)
  .then((src) => {
    $('#qr').src = src;
  })
  .catch(() => {});

if (!configured) showWaiting('Apresentação indisponível no momento');
else {
  watchConnection((st) => statusChip($('#conn'), st))
    .then(() => watchCurrent(follow))
    .catch(() => showWaiting('Apresentação indisponível no momento'));
}

$('#fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
