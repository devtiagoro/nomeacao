import {
  el,
  $,
  setText,
  announce,
  isMeetingId,
  statusChip,
  renderResults,
  STATUS_LABEL,
  fmtDate,
  plural,
  icon,
  toast,
  confirmDialog,
  emptyState,
} from './common.js';
import * as db from './db.js';
import { resultsCsv } from './domain.js';

// A segurança NÃO depende desta tela: toda gravação é verificada pelas regras do Firebase
// (database.rules.json), que só aceitam contas da mesa cadastradas em /admins.

const meetingId = new URLSearchParams(location.search).get('m');
let state = null;
let live = null;
let showOfficeForm = false;
let editingCandidate = null; // { id, value }
let selectedHistory = null;
const keys = {};

const MODE_LABEL = {
  on_publish: 'Resultados ocultos até publicar',
  on_close: 'Resultados publicados ao encerrar',
  live: 'Resultados ao vivo',
};

// ---------------- Utilidades ----------------

/** Erros: banner persistente (role=alert). Sucesso/informação: toast discreto. */
function flash(text, kind = 'error') {
  const f = $('#flash');
  if (!text) {
    f.replaceChildren();
    return;
  }
  if (kind !== 'error') {
    f.replaceChildren();
    toast(text, kind);
    return;
  }
  const close = el('button', { class: 'icon-btn banner-close', type: 'button', 'aria-label': 'Fechar aviso' }, icon('x'));
  close.addEventListener('click', () => f.replaceChildren());
  f.replaceChildren(el('div', { class: 'banner error' }, icon('alert'), el('span', {}, text), close));
  announce(text, { assertive: true });
}

function show(view) {
  for (const id of ['view-login', 'view-dashboard', 'view-meeting']) $(`#${id}`).hidden = id !== view;
  const inMeeting = view === 'view-meeting';
  for (const id of ['hdr-meeting', 'hdr-presentation', 'hdr-history']) $(`#${id}`).hidden = !inMeeting;
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
    return r;
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

const fileName = (ext) => `nomeia-${meetingId}-${new Date().toISOString().slice(0, 10)}.${ext}`;

/** Re-renderiza uma região somente quando seus dados mudarem (preserva foco e edição). */
function changed(name, value) {
  const k = JSON.stringify(value);
  if (keys[name] === k) return false;
  keys[name] = k;
  return true;
}

// ---------------- Login / sessão ----------------

function showLogin() {
  live?.();
  live = null;
  show('view-login');
  $('#logout').hidden = true;
  $('#conn').hidden = true;
  $('#email').focus();
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter;
  await action(btn, () => db.signIn($('#email').value.trim(), $('#secret').value));
  $('#secret').value = '';
});

$('#logout').addEventListener('click', async () => {
  await db.signOut().catch(() => {});
  toast('Sessão encerrada.', 'info');
});

// ---------------- Dashboard ----------------

function skeletonRows(cols, rows = 3) {
  return Array.from({ length: rows }, () =>
    el('tr', {}, Array.from({ length: cols }, () => el('td', {}, el('span', { class: 'skeleton sk-line sk-w-60' })))),
  );
}

async function showDashboard() {
  show('view-dashboard');
  document.title = 'Reuniões — Nomeia';
  const body = $('#meetings-body');
  body.replaceChildren(...skeletonRows(5));
  const list = await action(null, () => db.listMeetings({ includeArchived: true }));
  if (!list) return;
  body.replaceChildren(
    ...(list.length
      ? list.map((m) => {
          const href = `admin.html?m=${encodeURIComponent(m.id)}`;
          return el(
            'tr',
            {},
            el('td', {}, el('a', { class: 'meeting-link', href }, m.name)),
            el('td', {}, el('span', { class: `chip ${m.phase}` }, STATUS_LABEL[m.phase] || m.phase)),
            el('td', { class: 'num' }, String(m.offices)),
            el('td', { class: 'hide-sm muted' }, fmtDate(m.createdAt)),
            el('td', { class: 'num' }, el('a', { class: 'btn btn-secondary btn-sm', href, 'aria-label': `Abrir ${m.name}` }, 'Abrir', icon('arrow-right'))),
          );
        })
      : [
          el(
            'tr',
            {},
            el('td', { colspan: '5' }, emptyState({ iconName: 'calendar', title: 'Nenhuma reunião ainda', text: 'Crie a primeira reunião no formulário acima.' })),
          ),
        ]),
  );
}

$('#meeting-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = await action(ev.submitter, () => db.createMeeting({ name: $('#m-name').value, expectedParticipants: Number($('#m-expected').value) }));
  if (id) location.href = `admin.html?m=${encodeURIComponent(id)}`;
});

$('#import-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const file = $('#import-file').files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return flash('Arquivo maior que 10 MB.');
  let doc;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    return flash('Arquivo JSON inválido.');
  }
  const r = await action(ev.submitter, () => db.importMeeting(doc), 'Reunião importada.');
  if (r?.droppedOpenVotes) toast('Votos parciais de votações que estavam abertas na exportação não puderam ser restaurados.', 'info');
  if (r) setTimeout(() => (location.href = `admin.html?m=${encodeURIComponent(r.id)}`), r.droppedOpenVotes ? 2500 : 0);
});

// ---------------- Reunião ----------------

async function openMeeting() {
  show('view-meeting');
  $('#conn').hidden = false;
  const publicUrl = db.pageUrl('votar.html', meetingId);
  const presentationUrl = db.pageUrl('apresentacao.html', meetingId);
  $('#public-url').value = publicUrl;
  $('#presentation-url').value = presentationUrl;
  $('#presentation-open').href = presentationUrl;
  $('#hdr-presentation').href = presentationUrl;
  db.qrDataUrl(publicUrl)
    .then((src) => {
      $('#mt-qr').src = src;
    })
    .catch(() => {});
  if (!live) {
    db.watchConnection((st) => statusChip($('#conn'), st)).catch(() => {});
    live = await db.watchMeeting(
      meetingId,
      { admin: true },
      (s) => {
        state = s;
        renderMeeting();
      },
      (reason) => flash(reason === 'not_found' ? 'Reunião não encontrada.' : 'Acesso negado: esta conta não é administradora.'),
    );
  }
}

const currentOffice = () => state.offices.find((o) => o.id === state.currentOfficeId) || null;

function renderMeeting() {
  const s = state;
  const archived = s.status === 'archived';
  $('#meeting-skeleton').hidden = true;
  $('#meeting-content').hidden = false;
  setText('#mt-name', s.name);
  document.title = `${s.name} — Nomeia`;
  const st = $('#mt-status');
  st.className = `chip ${s.phase}`;
  st.textContent = STATUS_LABEL[s.phase] || s.phase;
  $('#mt-archived').hidden = !archived;
  for (const n of document.querySelectorAll('[data-mutating]')) n.hidden = archived;
  if (changed('meetingForm', [s.name, s.expectedParticipants])) {
    $('#e-name').value = s.name;
    $('#e-expected').value = s.expectedParticipants;
  }

  renderCurrent(archived);
  renderParticipation();
  renderHistory();
}

function renderCurrent(archived) {
  const o = currentOffice();
  const wantsForm = !archived && (!o || (o.status === 'closed' && showOfficeForm));
  $('#office-form').hidden = !wantsForm;
  $('#office-cancel').hidden = !o;
  $('#cur-office').hidden = !o || wantsForm;
  $('#cur-empty').hidden = Boolean(o) && !wantsForm;
  setText(
    '#cur-empty-text',
    o
      ? `O cargo anterior (${o.title}) foi encerrado e está no histórico. Cadastre o próximo cargo abaixo.`
      : 'Cadastre o primeiro cargo. Ele será apresentado imediatamente no telão e nos celulares, com a votação bloqueada.',
  );
  if (!o) return;

  const coStatus = $('#co-status');
  coStatus.className = `chip ${o.status}`;
  coStatus.textContent = STATUS_LABEL[o.status];
  setText('#co-mode-label', MODE_LABEL[o.resultsMode] || '');
  setText('#co-title', o.title);
  setText('#co-desc', o.description || '');
  setText('#cand-count', String(o.candidates.length));

  const editable = !archived && (o.status === 'discussing' || o.status === 'draft');
  $('#cand-form').hidden = !editable;
  if (changed('cands', [o.id, o.status, o.candidates, editable, editingCandidate?.id])) renderCandidates(o, editable);

  $('#mode-field').hidden = archived || o.status === 'closed';
  if (changed('mode', [o.id, o.resultsMode])) $('#co-mode').value = o.resultsMode;

  const closed = o.status === 'closed';
  $('#btn-open').hidden = o.status !== 'discussing';
  $('#btn-open').disabled = !o.candidates.length;
  $('#btn-open').title = o.candidates.length ? '' : 'Adicione ao menos um nome antes de abrir a votação';
  $('#btn-close').hidden = o.status !== 'voting_open';
  $('#btn-publish').hidden = !(closed && !o.resultsPublished);
  $('#btn-results').hidden = !closed;
  $('#btn-next').hidden = !closed;
  // Hierarquia: publicar é a ação principal até ser feita; depois, próximo cargo.
  $('#btn-next').className = `btn ${closed && !o.resultsPublished ? 'btn-secondary' : 'btn-primary'} btn-lg`;

  const res = $('#co-results');
  if (o.status === 'voting_open' && o.live) {
    const first = changed('liveOffice', o.id);
    res.replaceChildren(
      el(
        'div',
        { class: 'section-head' },
        el('h4', {}, 'Apuração parcial'),
        el('span', { class: 'live-badge' }, icon(o.resultsMode === 'live' ? 'eye' : 'lock'), o.resultsMode === 'live' ? 'visível para todos' : 'somente a mesa vê'),
      ),
      renderResults(o.live, { animate: first }),
    );
  } else if (closed && o.result) {
    if (changed('closedResult', [o.id, o.resultsPublished])) {
      res.replaceChildren(
        el('div', { class: 'section-head' }, el('h4', {}, 'Resultado final')),
        el(
          'p',
          { class: `banner ${o.resultsPublished ? 'success' : 'warn'} mb-4` },
          icon(o.resultsPublished ? 'check-circle' : 'eye'),
          el('span', {}, o.resultsPublished ? 'Resultado publicado para participantes e apresentação.' : 'Resultado ainda não publicado: apenas a mesa vê.'),
        ),
        renderResults(o.result, { animate: true }),
        el('p', { class: 'hash' }, `Integridade (SHA-256): ${o.resultHash}`),
      );
    }
  } else if (closed && !o.result) {
    // Encerrada, mas a conexão caiu antes de gravar o resultado: permite concluir a apuração.
    keys.closedResult = '';
    const seal = el('button', { class: 'btn btn-primary', type: 'button' }, icon('check-circle'), 'Concluir apuração');
    seal.addEventListener('click', () => action(seal, () => db.sealResult(meetingId, o.id), 'Resultado registrado.'));
    res.replaceChildren(el('p', { class: 'banner warn mb-4' }, icon('alert'), el('span', {}, 'Votação encerrada, mas o resultado ainda não foi registrado.')), seal);
  } else if (o.status === 'discussing') {
    keys.closedResult = '';
    res.replaceChildren(
      el(
        'p',
        { class: 'banner info' },
        icon('lock'),
        el('span', {}, o.candidates.length ? 'Votação bloqueada durante a discussão. Abra a votação quando a lista estiver pronta.' : 'Adicione os nomes indicados para liberar a abertura da votação.'),
      ),
    );
  } else res.replaceChildren();
}

function renderCandidates(o, editable) {
  const list = $('#cand-list');
  if (!o.candidates.length) {
    list.replaceChildren(el('li', { class: 'cand-empty' }, editable ? 'Nenhum nome indicado ainda. Use o campo abaixo para adicionar.' : 'Nenhum nome indicado.'));
    return;
  }
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
          keys.cands = '';
          renderMeeting();
        };
        cancel.addEventListener('click', stopEditing);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') stopEditing();
        });
        const form = el('form', { class: 'cand-edit' }, input, save, cancel);
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const ok = await action(save, async () => (await db.renameCandidate(meetingId, o.id, c.id, input.value), true), 'Nome atualizado.');
          if (ok) {
            editingCandidate = null;
            keys.cands = '';
            renderMeeting();
          }
        });
        setTimeout(() => input.focus(), 0);
        return el('li', { class: 'cand-item' }, index, form);
      }
      const li = el('li', { class: 'cand-item' }, index, el('span', { class: 'cand-name' }, c.name));
      if (editable) {
        const edit = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Editar ${c.name}`, title: 'Editar' }, icon('edit'));
        edit.addEventListener('click', () => {
          editingCandidate = { id: c.id, value: c.name };
          keys.cands = '';
          renderMeeting();
        });
        const del = el('button', { class: 'icon-btn danger', type: 'button', 'aria-label': `Remover ${c.name}`, title: 'Remover' }, icon('trash'));
        del.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Remover nome?',
            message: `"${c.name}" sairá da lista deste cargo. Os celulares e o telão serão atualizados.`,
            confirmLabel: 'Remover',
            danger: true,
          });
          if (ok) action(del, () => db.removeCandidate(meetingId, o.id, c.id), 'Nome removido.');
        });
        li.append(el('span', { class: 'cand-actions' }, edit, del));
      }
      return li;
    }),
  );
}

function renderParticipation() {
  const s = state;
  const o = currentOffice();
  const r = o && (o.status === 'voting_open' ? o.live : o.status === 'closed' ? o.result : null);
  // Pessoas presentes (informado pela mesa) e votos recebidos são números independentes.
  setText('#s-expected', s.expectedParticipants);
  setText('#s-voted', r ? r.castVotes : '—');
  setText('#s-abst', r ? r.abstentions : '—');
  setText('#s-valid', r ? r.validVotes : '—');
}

function openHistory(id) {
  selectedHistory = id;
  keys.hist = '';
  keys.histDetail = '';
  renderHistory();
  const detail = $('#hist-detail');
  detail.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  detail.focus({ preventScroll: true });
}

function renderHistory() {
  const closed = state.offices.filter((o) => o.status === 'closed');
  if (changed('hist', [closed.map((o) => [o.id, o.title, o.resultsPublished, Boolean(o.result)]), selectedHistory])) {
    const list = $('#hist-list');
    list.replaceChildren(
      ...(closed.length
        ? closed.map((o) => {
            const r = o.result;
            const btn = r
              ? el('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-controls': 'hist-detail', 'aria-label': `Ver resultado de ${o.title}` }, icon('chart'), 'Ver resultado')
              : el('span', { class: 'badge' }, 'apurando…');
            if (r) btn.addEventListener('click', () => openHistory(o.id));
            return el(
              'tr',
              { class: o.id === selectedHistory ? 'is-selected' : '' },
              el('td', {}, o.title, o.resultsPublished ? null : el('span', { class: 'badge', title: 'Resultado não publicado' }, 'não publicado')),
              el('td', { class: 'muted' }, fmtDate(o.closedAt)),
              el('td', { class: 'num' }, String(o.candidates.length)),
              el('td', { class: 'num' }, r ? String(r.castVotes) : '—'),
              el('td', { class: 'num' }, String(r?.presentParticipants ?? r?.expectedParticipants ?? '—')),
              el('td', { class: 'num' }, btn),
            );
          })
        : [
            el(
              'tr',
              {},
              el(
                'td',
                { colspan: '6' },
                emptyState({ iconName: 'history', title: 'Nenhum cargo encerrado', text: 'Ao encerrar uma votação, o resultado selado aparece aqui para consulta e exportação.' }),
              ),
            ),
          ]),
    );
  }
  const o = closed.find((x) => x.id === selectedHistory && x.result);
  const detail = $('#hist-detail');
  detail.hidden = !o;
  if (!o || !changed('histDetail', [o.id, o.resultsPublished, state.status])) return;
  detail.tabIndex = -1;
  const csv = el('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, icon('download'), 'Exportar CSV');
  csv.addEventListener('click', () =>
    action(csv, async () => {
      const doc = await db.exportMeeting(meetingId);
      download(fileName('csv'), 'text/csv;charset=utf-8', resultsCsv(doc.meeting, doc.results, [o.id]));
    }),
  );
  const pub =
    !o.resultsPublished && state.status === 'active' ? el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('eye'), 'Publicar resultado') : null;
  pub?.addEventListener('click', () => action(pub, () => db.publishResults(meetingId, o.id), 'Resultado publicado.'));
  const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar detalhes' }, icon('x'));
  closeBtn.addEventListener('click', () => {
    selectedHistory = null;
    keys.hist = '';
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
        o.description ? el('p', { class: 'muted small mt-1' }, o.description) : null,
        el(
          'div',
          { class: 'history-meta' },
          el('span', {}, icon('play'), `Aberta em ${fmtDate(o.openedAt)}`),
          el('span', {}, icon('lock'), `Encerrada em ${fmtDate(o.closedAt)}`),
          el('span', {}, icon('eye'), o.resultsPublished ? `Publicada em ${fmtDate(o.publishedAt)}` : 'Não publicada'),
        ),
      ),
      el('div', { class: 'row' }, pub, csv, closeBtn),
    ),
    renderResults(o.result, { animate: true }),
    el('p', { class: 'hash' }, `SHA-256: ${o.resultHash}`),
  );
}

// ---------------- Ações do cargo ----------------

$('#office-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = await action(ev.submitter, () =>
    db.createOffice(meetingId, { title: $('#o-title').value, description: $('#o-desc').value, resultsMode: $('#o-mode').value, start: true }),
  );
  if (r) {
    showOfficeForm = false;
    $('#office-form').reset();
    toast('Cargo apresentado. Adicione os nomes indicados.');
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
  const r = await action(ev.submitter, async () => (await db.addCandidate(meetingId, o.id, name), true));
  if (r) {
    $('#cand-name').value = '';
    $('#cand-name').focus();
    announce(`${name.trim()} adicionado.`);
  }
});

$('#co-mode').addEventListener('change', () => {
  const o = currentOffice();
  if (o) action($('#co-mode'), () => db.setResultsMode(meetingId, o.id, $('#co-mode').value), 'Modo de resultados atualizado.');
});

$('#btn-open').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const o = currentOffice();
  if (!o) return;
  const ok = await confirmDialog({
    title: 'Abrir votação?',
    message: `"${o.title}" com ${plural(o.candidates.length, 'nome', 'nomes')}. A lista ficará bloqueada e todos os celulares conectados poderão votar.`,
    confirmLabel: 'Abrir votação',
    iconName: 'play',
  });
  if (ok) action(btn, () => db.openVoting(meetingId, o.id), 'Votação aberta.');
});

$('#btn-close').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const o = currentOffice();
  if (!o) return;
  const votes = o.live ? o.live.castVotes : 0;
  const ok = await confirmDialog({
    title: 'Encerrar votação?',
    message: `${plural(votes, 'voto recebido', 'votos recebidos')} até agora. Novos votos serão recusados e o resultado de "${o.title}" ficará selado e imutável.`,
    confirmLabel: 'Encerrar votação',
    danger: true,
  });
  if (ok) action(btn, () => db.closeVoting(meetingId, o.id), 'Votação encerrada e resultado registrado.');
});

$('#btn-publish').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const o = currentOffice();
  if (!o) return;
  const ok = await confirmDialog({
    title: 'Publicar resultados?',
    message: 'O resultado completo aparecerá no telão e nos celulares dos participantes.',
    confirmLabel: 'Publicar',
    iconName: 'eye',
  });
  if (ok) action(btn, () => db.publishResults(meetingId, o.id), 'Resultado publicado.');
});

$('#btn-results').addEventListener('click', () => {
  const o = currentOffice();
  if (o) openHistory(o.id);
});

$('#btn-next').addEventListener('click', () => {
  showOfficeForm = true;
  renderMeeting();
  $('#o-title').focus();
});

// ---------------- Reunião: edição e backup ----------------

$('#edit-meeting-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  action(
    ev.submitter,
    () => db.updateMeeting(meetingId, { name: $('#e-name').value, expectedParticipants: Number($('#e-expected').value) }),
    'Reunião atualizada.',
  );
});

$('#exp-json').addEventListener('click', (ev) =>
  action(
    ev.currentTarget,
    async () => download(fileName('json'), 'application/json', JSON.stringify(await db.exportMeeting(meetingId), null, 2)),
    'Exportação JSON gerada.',
  ),
);

$('#exp-csv').addEventListener('click', (ev) =>
  action(
    ev.currentTarget,
    async () => {
      const doc = await db.exportMeeting(meetingId);
      download(fileName('csv'), 'text/csv;charset=utf-8', resultsCsv(doc.meeting, doc.results));
    },
    'Exportação CSV gerada.',
  ),
);

$('#btn-archive').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const unpublished = state?.offices.filter((o) => o.status === 'closed' && !o.resultsPublished).length || 0;
  const ok = await confirmDialog({
    title: 'Encerrar reunião?',
    message: `A reunião ficará somente para leitura e não aceitará novos cargos nem votos.${
      unpublished ? ` Atenção: ${plural(unpublished, 'cargo tem', 'cargos têm')} resultado não publicado.` : ''
    } Esta ação não pode ser desfeita.`,
    confirmLabel: 'Encerrar reunião',
    danger: true,
  });
  if (ok) action(btn, () => db.archiveMeeting(meetingId), 'Reunião encerrada.');
});

for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    const input = $(b.dataset.copy);
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand?.('copy');
    }
    toast('Link copiado.');
  });
}

// ---------------- Início ----------------

function boot() {
  if (!db.configured) {
    show('view-login');
    flash('Esta publicação ainda não está ligada ao Firebase. Preencha js/firebase-config.js (veja o README).');
    $('#login-form').hidden = true;
    return;
  }
  db.watchAdmin(({ user, isAdmin }) => {
    if (!user) return showLogin();
    if (!isAdmin) {
      flash('Esta conta não tem permissão de administrador. Peça para cadastrá-la em /admins no Firebase.');
      db.signOut().catch(() => {});
      return;
    }
    flash('');
    $('#logout').hidden = false;
    if (isMeetingId(meetingId)) openMeeting();
    else showDashboard();
  }).catch((e) => flash(e.message));
}

boot();
