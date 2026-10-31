import { el, $, setText, announce, statusChip, renderResults, STATUS_LABEL, fmtDate, plural, icon, toast, confirmDialog, emptyState } from './common.js';
import * as db from './db.js';
import { resultsCsv, VOTE_TYPE_LABEL } from './domain.js';

// A segurança NÃO depende desta tela: toda gravação é verificada pelas regras do Firebase
// (database.rules.json), que só aceitam contas cadastradas em /admins.

let meetingId = null;
let stopMeeting = null;
let stopCurrent = null;
let state = null;
let showOfficeForm = false;
let editingCandidate = null; // { id, value }
let selectedHistory = null;
const keys = {};

// ---------------- Utilidades ----------------

/** Erros: banner persistente (role=alert). Sucesso: toast discreto. */
function flash(text) {
  const f = $('#flash');
  if (!text) return f.replaceChildren();
  const close = el('button', { class: 'icon-btn banner-close', type: 'button', 'aria-label': 'Fechar aviso' }, icon('x'));
  close.addEventListener('click', () => f.replaceChildren());
  f.replaceChildren(el('div', { class: 'banner error' }, icon('alert'), el('span', {}, text), close));
  announce(text, { assertive: true });
}

function show(view) {
  for (const id of ['view-login', 'view-setup', 'view-meeting']) $(`#${id}`).hidden = id !== view;
  $('#hdr-meeting').hidden = view !== 'view-meeting';
  $('#hdr-presentation').hidden = view === 'view-login';
}

/** Executa uma ação com botão em estado de carregamento e erro amigável. */
async function action(btn, fn, okMsg) {
  if (btn) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  }
  try {
    const r = await fn();
    flash('');
    if (okMsg) toast(okMsg);
    return r ?? true;
  } catch (e) {
    flash(e.code === 'permission_denied' ? 'Operação recusada pelas regras de segurança. Confira se a sua conta é administradora.' : e.message);
    return undefined;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  }
}

/** Baixa um arquivo gerado no navegador (exportações). */
function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileName = (ext) => `nomeia-${(state?.name || 'reuniao').replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.${ext}`;

/** Re-renderiza uma região somente quando seus dados mudarem (preserva foco e edição). */
function changed(name, value) {
  const k = JSON.stringify(value);
  if (keys[name] === k) return false;
  keys[name] = k;
  return true;
}

// ---------------- Login ----------------

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await action(ev.submitter, () => db.signIn($('#email').value.trim(), $('#secret').value));
  $('#secret').value = '';
});

$('#logout').addEventListener('click', () => db.signOut().catch(() => {}));

// ---------------- Nova reunião / reuniões anteriores ----------------

async function showSetup() {
  show('view-setup');
  document.title = 'Administração — Nomeia';
  $('#setup-cancel').hidden = !meetingId;
  const list = $('#meetings-list');
  const meetings = await action(null, () => db.listMeetings());
  if (!meetings) return;
  const others = meetings.filter((m) => m.id !== meetingId);
  list.replaceChildren(
    ...(others.length
      ? others.map((m) => {
          const btn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, 'Retomar');
          btn.addEventListener('click', async () => {
            const ok = await confirmDialog({
              title: 'Retomar esta reunião?',
              message: `"${m.name}" passa a ser a reunião em andamento: a apresentação e os celulares mudam para ela.`,
              confirmLabel: 'Retomar',
            });
            if (ok) action(btn, () => db.setCurrentMeeting(m.id));
          });
          return el('li', { class: 'meeting-row' }, el('span', {}, el('strong', {}, m.name), el('small', { class: 'muted' }, ` · ${fmtDate(m.createdAt)} · ${plural(m.offices, 'cargo', 'cargos')}`)), btn);
        })
      : [el('li', {}, emptyState({ iconName: 'calendar', title: 'Nenhuma reunião anterior' }))]),
  );
}

$('#meeting-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ok = await action(ev.submitter, () => db.createMeeting({ name: $('#m-name').value, expectedParticipants: Number($('#m-present').value) }), 'Reunião criada.');
  if (ok) $('#meeting-form').reset();
});

$('#setup-cancel').addEventListener('click', () => show('view-meeting'));
$('#btn-setup').addEventListener('click', () => {
  if (currentOffice()?.status === 'voting_open') return flash('Encerre a votação em andamento antes de trocar de reunião.');
  showSetup();
});

// ---------------- Reunião ----------------

function leave() {
  stopMeeting?.();
  stopMeeting = null;
  meetingId = null;
  state = null;
  showOfficeForm = false;
  selectedHistory = null;
  editingCandidate = null;
  for (const k of Object.keys(keys)) delete keys[k];
}

async function follow(id) {
  leave();
  if (!id) return showSetup();
  meetingId = id;
  show('view-meeting');
  const stop = await db.watchMeeting(
    id,
    { admin: true },
    (s) => {
      if (meetingId !== id) return;
      state = s;
      renderMeeting();
    },
    (reason) => flash(reason === 'not_found' ? 'Reunião não encontrada.' : 'Acesso negado: esta conta não é administradora.'),
  );
  if (meetingId === id) stopMeeting = stop;
  else stop();
}

const currentOffice = () => state?.currentOffice || null;

function renderMeeting() {
  setText('#mt-name', state.name);
  document.title = `${state.name} — Nomeia`;
  if (changed('present', state.expectedParticipants)) $('#present').value = state.expectedParticipants;
  const o = currentOffice();
  setText('#s-ballots', o && o.status !== 'draft' && o.status !== 'discussing' ? o.ballots : '—');
  renderCurrent(o);
  renderHistory();
}

function renderCurrent(o) {
  const wantsForm = !o || (o.status === 'closed' && showOfficeForm);
  $('#office-form').hidden = !wantsForm;
  $('#office-cancel').hidden = !o;
  $('#cur-office').hidden = wantsForm;
  if (wantsForm) return;

  const coStatus = $('#co-status');
  coStatus.className = `chip ${o.status}`;
  coStatus.textContent = STATUS_LABEL[o.status];
  setText('#co-type', o.voteType === 'multiple' ? `${VOTE_TYPE_LABEL.multiple} · até ${o.maxChoices} nomes` : VOTE_TYPE_LABEL.single);
  setText('#co-title', o.title);
  setText('#cand-count', String(o.candidates.length));

  const editable = o.status === 'draft' || o.status === 'discussing';
  $('#cand-form').hidden = !editable;
  if (changed('cands', [o.id, o.candidates, editable, editingCandidate?.id])) renderCandidates(o, editable);

  $('#live-field').hidden = o.status === 'closed';
  $('#co-live').checked = o.liveResults;

  $('#btn-present').hidden = o.status !== 'draft';
  $('#btn-open').hidden = o.status !== 'discussing';
  $('#btn-open').disabled = !o.candidates.length;
  $('#btn-close').hidden = o.status !== 'voting_open';
  $('#btn-next').hidden = o.status !== 'closed';

  const res = $('#co-results');
  if ((o.status === 'voting_open' || o.status === 'closed') && o.result) {
    if (changed('result', [o.id, o.status, o.result])) {
      const first = changed('resultOffice', [o.id, o.status]);
      res.replaceChildren(el('div', { class: 'section-head' }, el('h4', {}, o.status === 'closed' ? 'Resultado final' : 'Resultado parcial')), renderResults(o.result, { animate: first }));
    }
  } else {
    keys.result = '';
    const hint =
      o.status === 'draft'
        ? 'Em preparação: ainda não aparece na apresentação. Adicione os nomes e clique em "Apresentar".'
        : 'Apresentado na tela e nos celulares. A votação abre quando você clicar em "Abrir votação".';
    res.replaceChildren(el('p', { class: 'banner info' }, icon(o.status === 'draft' ? 'edit' : 'monitor'), el('span', {}, hint)));
  }
}

function renderCandidates(o, editable) {
  const list = $('#cand-list');
  if (!o.candidates.length) {
    list.replaceChildren(el('li', { class: 'cand-empty' }, 'Nenhum nome ainda.'));
    return;
  }
  const rerender = () => {
    keys.cands = '';
    renderMeeting();
  };
  list.replaceChildren(
    ...o.candidates.map((c, i) => {
      const index = el('span', { class: 'cand-index', 'aria-hidden': 'true' }, String(i + 1));
      if (editable && editingCandidate?.id === c.id) {
        const input = el('input', { type: 'text', maxlength: '120', 'aria-label': `Novo nome para ${c.name}` });
        input.value = editingCandidate.value;
        input.addEventListener('input', () => {
          editingCandidate.value = input.value;
        });
        const save = el('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Salvar');
        const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Cancelar');
        const stopEditing = () => {
          editingCandidate = null;
          rerender();
        };
        cancel.addEventListener('click', stopEditing);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') stopEditing();
        });
        const form = el('form', { class: 'cand-edit' }, input, save, cancel);
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          if (await action(save, () => db.renameCandidate(meetingId, o.id, c.id, input.value))) stopEditing();
        });
        setTimeout(() => input.focus(), 0);
        return el('li', { class: 'cand-item' }, index, form);
      }
      const li = el('li', { class: 'cand-item' }, index, el('span', { class: 'cand-name' }, c.name));
      if (editable) {
        const edit = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Editar ${c.name}`, title: 'Editar' }, icon('edit'));
        edit.addEventListener('click', () => {
          editingCandidate = { id: c.id, value: c.name };
          rerender();
        });
        const del = el('button', { class: 'icon-btn danger', type: 'button', 'aria-label': `Remover ${c.name}`, title: 'Remover' }, icon('trash'));
        del.addEventListener('click', () => action(del, () => db.removeCandidate(meetingId, o.id, c.id), `"${c.name}" removido.`));
        li.append(el('span', { class: 'cand-actions' }, edit, del));
      }
      return li;
    }),
  );
}

function openHistory(id) {
  selectedHistory = id;
  keys.hist = '';
  renderHistory();
  $('#hist-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#hist-detail').focus({ preventScroll: true });
}

function renderHistory() {
  const closed = state.offices.filter((o) => o.status === 'closed');
  if (changed('hist', [closed.map((o) => [o.id, o.title, o.result]), selectedHistory])) {
    $('#hist-list').replaceChildren(
      ...(closed.length
        ? closed.map((o) => {
            const btn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-controls': 'hist-detail', 'aria-label': `Ver resultado de ${o.title}` }, icon('chart'), 'Ver');
            btn.addEventListener('click', () => openHistory(o.id));
            return el(
              'tr',
              { class: o.id === selectedHistory ? 'is-selected' : '' },
              el('td', {}, o.title),
              el('td', { class: 'hide-sm muted' }, o.voteType === 'multiple' ? `Múltipla (até ${o.maxChoices})` : 'Única'),
              el('td', { class: 'muted' }, fmtDate(o.closedAt)),
              el('td', { class: 'num' }, String(o.ballots)),
              el('td', { class: 'num hide-sm' }, String(o.result?.abstentions ?? '—')),
              el('td', { class: 'num' }, btn),
            );
          })
        : [el('tr', {}, el('td', { colspan: '6' }, emptyState({ iconName: 'history', title: 'Nenhum cargo encerrado', text: 'Os resultados aparecem aqui ao encerrar cada votação.' })))]),
    );
  }
  const o = closed.find((x) => x.id === selectedHistory && x.result);
  const detail = $('#hist-detail');
  detail.hidden = !o;
  if (!o || !changed('histDetail', [o.id, o.result])) return;
  const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar detalhes' }, icon('x'));
  closeBtn.addEventListener('click', () => {
    selectedHistory = null;
    keys.histDetail = '';
    renderHistory();
  });
  detail.replaceChildren(
    el(
      'div',
      { class: 'history-detail-head' },
      el(
        'div',
        {},
        el('h3', {}, o.title),
        el(
          'div',
          { class: 'history-meta' },
          el('span', {}, icon('ballot'), VOTE_TYPE_LABEL[o.voteType] + (o.voteType === 'multiple' ? ` (até ${o.maxChoices})` : '')),
          el('span', {}, icon('play'), `Aberta em ${fmtDate(o.openedAt)}`),
          el('span', {}, icon('lock'), `Encerrada em ${fmtDate(o.closedAt)}`),
        ),
      ),
      closeBtn,
    ),
    renderResults(o.result, { animate: true }),
  );
}

// ---------------- Ações ----------------

$('#present-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  action(ev.submitter, () => db.setPresent(meetingId, Number($('#present').value)), 'Presentes atualizado.');
});

for (const r of document.querySelectorAll('input[name="o-type"]')) {
  r.addEventListener('change', () => {
    $('#o-max-field').hidden = $('input[name="o-type"]:checked').value !== 'multiple';
  });
}

$('#office-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const voteType = $('input[name="o-type"]:checked').value;
  const ok = await action(ev.submitter, () => db.createOffice(meetingId, { title: $('#o-title').value, voteType, maxChoices: Number($('#o-max').value) }));
  if (ok) {
    showOfficeForm = false;
    $('#office-form').reset();
    $('#o-max-field').hidden = true;
    $('#cand-name').focus();
  }
});

$('#office-cancel').addEventListener('click', () => {
  showOfficeForm = false;
  renderMeeting();
});

$('#cand-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const o = currentOffice();
  const name = $('#cand-name').value;
  if (!o || !name.trim()) return;
  if (await action(ev.submitter, () => db.addCandidate(meetingId, o.id, name))) {
    $('#cand-name').value = '';
    $('#cand-name').focus();
    announce(`${name.trim()} adicionado.`);
  }
});

$('#co-live').addEventListener('change', (ev) => {
  const o = currentOffice();
  if (o) action(ev.currentTarget, () => db.setLiveResults(meetingId, o.id, ev.currentTarget.checked));
});

$('#btn-present').addEventListener('click', (ev) => {
  const o = currentOffice();
  if (o) action(ev.currentTarget, () => db.presentOffice(meetingId, o.id), 'Cargo apresentado.');
});

$('#btn-open').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const o = currentOffice();
  if (!o) return;
  const ok = await confirmDialog({
    title: 'Abrir votação?',
    message: `"${o.title}" com ${plural(o.candidates.length, 'nome', 'nomes')}. A lista ficará bloqueada até o encerramento.`,
    confirmLabel: 'Abrir votação',
    iconName: 'play',
  });
  if (ok) action(btn, () => db.openVoting(meetingId, o.id), 'Votação aberta.');
});

$('#btn-close').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const o = currentOffice();
  if (!o) return;
  const ok = await confirmDialog({
    title: 'Encerrar votação?',
    message: `${plural(o.ballots, 'voto registrado', 'votos registrados')}. Novos votos serão recusados e o resultado de "${o.title}" será exibido para todos.`,
    confirmLabel: 'Encerrar votação',
    danger: true,
  });
  if (ok) action(btn, () => db.closeVoting(meetingId, o.id), 'Votação encerrada.');
});

$('#btn-next').addEventListener('click', () => {
  showOfficeForm = true;
  renderMeeting();
  $('#o-title').focus();
});

$('#exp-json').addEventListener('click', (ev) =>
  action(ev.currentTarget, async () => download(fileName('json'), 'application/json', JSON.stringify(await db.exportMeeting(meetingId), null, 2))),
);

$('#exp-csv').addEventListener('click', (ev) =>
  action(ev.currentTarget, async () => {
    const doc = await db.exportMeeting(meetingId);
    download(fileName('csv'), 'text/csv;charset=utf-8', resultsCsv(doc.meeting, doc.counts, doc.tallies));
  }),
);

$('#copy-url').addEventListener('click', async () => {
  const input = $('#public-url');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand?.('copy');
  }
  toast('Link copiado.');
});

// ---------------- Início ----------------

function boot() {
  if (!db.configured) {
    show('view-login');
    $('#login-form').hidden = true;
    flash('Firebase não configurado: preencha public/js/firebase-config.js (veja o README).');
    return;
  }
  const publicUrl = db.pageUrl('votar.html');
  $('#public-url').value = publicUrl;
  db.qrDataUrl(publicUrl)
    .then((src) => {
      $('#mt-qr').src = src;
    })
    .catch(() => {});
  db.watchConnection((st) => statusChip($('#conn'), st)).catch(() => {});
  db.watchAdmin(async ({ user, isAdmin }) => {
    stopCurrent?.();
    stopCurrent = null;
    if (!user || !isAdmin) {
      leave();
      show('view-login');
      $('#logout').hidden = $('#conn').hidden = true;
      if (user) {
        flash('Esta conta não tem permissão de administrador (cadastre o UID em /admins no Firebase).');
        db.signOut().catch(() => {});
      }
      return;
    }
    flash('');
    $('#logout').hidden = $('#conn').hidden = false;
    stopCurrent = await db.watchCurrent((id) => follow(id).catch((e) => flash(e.message)));
  }).catch((e) => flash(e.message));
}

boot();
