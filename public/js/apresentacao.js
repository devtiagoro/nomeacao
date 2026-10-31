import {
  api,
  el,
  $,
  setText,
  announce,
  connectLive,
  isMeetingId,
  statusChip,
  renderResults,
  STATUS_LABEL,
  registerServiceWorker,
  icon,
  apiUrl,
  serverMissing,
  storage,
} from './common.js';

registerServiceWorker();

const meetingId = new URLSearchParams(location.search).get('m') || storage.lastMeeting();
let lastCandidatesKey = '';
let lastResultsKey = '';
let resultsShownFor = null;

function fail(text) {
  const e = $('#error');
  e.replaceChildren(icon('alert'), el('span', {}, text));
  e.hidden = false;
  setText('#office-title', 'Apresentação indisponível');
}

const STATUS_LINE = {
  discussing: ['users', 'Em discussão — a votação ainda não foi aberta.'],
  voting_open: ['ballot', 'Votação aberta — leia o QR Code e vote pelo celular.'],
  closed: ['lock', 'Votação encerrada.'],
};

/** Visão do palco: waiting | discussing | voting | closed | results | archived. */
function viewOf(s, o) {
  if (s.status === 'archived') return 'archived';
  if (!o) return 'waiting';
  if (o.status === 'discussing') return 'discussing';
  if (o.status === 'voting_open') return 'voting';
  return o.results ? 'results' : 'closed';
}

function render(s, type) {
  const o = s.currentOffice;
  const view = viewOf(s, o);
  $('#stage').dataset.view = view;
  setText('#meeting-name', s.name);
  setText('#meeting-title', s.name);
  document.title = `${s.name} — Apresentação`;

  // Título e estado
  if (view === 'archived') {
    setText('#office-title', 'Reunião encerrada');
    setText('#office-desc', 'Obrigado pela participação.');
    $('#office-status').replaceChildren(el('span', { class: 'chip archived' }, STATUS_LABEL.archived));
    $('#status-line').replaceChildren();
  } else if (!o) {
    setText('#office-title', 'Aguardando o primeiro cargo');
    setText('#office-desc', 'Leia o QR Code para acompanhar a reunião pelo celular.');
    $('#office-status').replaceChildren();
    $('#status-line').replaceChildren();
  } else {
    setText('#office-title', o.title);
    setText('#office-desc', o.description || '');
    $('#office-status').replaceChildren(el('span', { class: `chip ${o.status}` }, STATUS_LABEL[o.status]));
    const [ic, text] = STATUS_LINE[o.status] || [];
    $('#status-line').replaceChildren(...(text ? [icon(ic), el('span', {}, view === 'results' ? 'Resultado da votação' : text)] : []));
  }

  // Nomes indicados (some quando há resultados no palco)
  const showCandidates = o && s.status !== 'archived' && !o.results;
  const ck = JSON.stringify([showCandidates, o?.candidates]);
  if (ck !== lastCandidatesKey) {
    lastCandidatesKey = ck;
    $('#candidates').replaceChildren(
      showCandidates
        ? o.candidates.length
          ? el(
              'ul',
              { class: 'stage-candidates candidate-list', 'aria-label': 'Nomes indicados' },
              o.candidates.map((c, i) => el('li', {}, el('span', { class: 'idx', 'aria-hidden': 'true' }, String(i + 1)), el('span', {}, c.name))),
            )
          : el('p', { class: 'stage-empty' }, 'Nenhum nome indicado ainda.')
        : '',
    );
  }

  // Resultados: animados na primeira exibição de cada cargo
  const rk = JSON.stringify([o?.id, o?.results]);
  if (rk !== lastResultsKey) {
    lastResultsKey = rk;
    let node = '';
    if (o && o.results) {
      const firstForOffice = resultsShownFor !== o.id;
      resultsShownFor = o.id;
      node = el(
        'section',
        { class: 'stage-results' },
        el('h3', {}, o.status === 'closed' ? 'Resultado' : 'Apuração parcial'),
        renderResults(o.results, { animate: firstForOffice }),
      );
    } else if (o && o.status === 'closed') {
      node = el('p', { class: 'stage-status' }, icon('clock'), el('span', {}, 'O resultado será divulgado pela mesa.'));
    }
    $('#results').replaceChildren(node);
  }

  // Contadores independentes: votos enviados × pessoas presentes (informado pela mesa).
  setText('#t-voted', o ? o.turnout.votes : 0);
  setText('#t-expected', s.expectedParticipants);
  $('#turnout-card').hidden = !o || o.status === 'discussing';

  const msgs = {
    vote_opened: 'Votação aberta.',
    vote_closed: 'Votação encerrada.',
    results_published: 'Resultados publicados.',
    next_office: o && `Próximo cargo: ${o.title}.`,
  };
  if (msgs[type]) announce(msgs[type]);
}

if (!isMeetingId(meetingId)) {
  // Sem reunião escolhida: a página inicial lista as reuniões disponíveis.
  location.replace('index.html');
} else {
  storage.rememberMeeting(meetingId);
  if (!serverMissing) $('#qr').src = apiUrl(`/api/meetings/${meetingId}/qr.svg`);
  api(`/api/meetings/${meetingId}/link`)
    .then((r) => setText('#public-link', r.publicUrl))
    .catch(() => setText('#public-link', new URL(`votar.html?m=${meetingId}`, location.href).href));
  connectLive({
    meetingId,
    onState: render,
    onStatus: (st) => statusChip($('#conn'), st),
    onFatal: (reason) =>
      fail(reason === 'server_not_configured' ? 'Esta publicação ainda não está ligada a um servidor do NOMEIA (js/config.js).' : 'Reunião não encontrada.'),
  });
}

$('#fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
