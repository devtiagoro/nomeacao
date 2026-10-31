// NOMEIA — acesso ao Firebase Realtime Database (fonte compartilhada, em tempo real).
// O SDK oficial é carregado do CDN do Google. Nenhuma regra de permissão vive aqui:
// as validações deste arquivo melhoram a experiência, mas quem decide é database.rules.json.

import { firebaseConfig, emulator } from './firebase-config.js';
import * as D from './domain.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';
const WRITE_TIMEOUT_MS = 15_000;

export const configured = Boolean(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.databaseURL);

export class DataError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NOT_CONFIGURED = 'O Firebase ainda não foi configurado nesta publicação (js/firebase-config.js).';
const OFFLINE = 'Sem conexão com o serviço de votação. Verifique a internet/Wi-Fi e tente novamente.';

let loading = null;
let connected = false;

/** Carrega o SDK e inicializa o app uma única vez. */
function load() {
  if (!configured) return Promise.reject(new DataError('not_configured', NOT_CONFIGURED));
  loading ??= (async () => {
    let appM, d, a;
    try {
      [appM, d, a] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`), import(`${SDK}/firebase-auth.js`)]);
    } catch {
      loading = null;
      throw new DataError('network_error', OFFLINE);
    }
    const app = appM.initializeApp(firebaseConfig);
    const db = d.getDatabase(app);
    const auth = a.getAuth(app);
    if (emulator) {
      d.connectDatabaseEmulator(db, emulator.host, emulator.databasePort);
      a.connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
    }
    d.onValue(d.ref(db, '.info/connected'), (s) => {
      connected = s.val() === true;
    });
    return { d, a, db, auth };
  })();
  return loading;
}

const isDenied = (e) => /PERMISSION[_ ]DENIED/i.test(`${e?.code || ''} ${e?.message || ''}`);

/** Traduz erros do SDK em mensagens para a interface. */
function translate(e) {
  if (e instanceof DataError || e instanceof D.DomainError) return e;
  if (isDenied(e)) return new DataError('permission_denied', 'Operação recusada pelas regras de segurança do banco.');
  return new DataError('network_error', OFFLINE);
}

function withTimeout(promise, ms = WRITE_TIMEOUT_MS) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new DataError('network_error', OFFLINE)), ms);
    }),
  ]);
}

async function write(fn) {
  const fb = await load();
  try {
    return await withTimeout(fn(fb));
  } catch (e) {
    throw translate(e);
  }
}

async function read(path) {
  const { d, db } = await load();
  try {
    return (await withTimeout(d.get(d.ref(db, path)))).val();
  } catch (e) {
    throw translate(e);
  }
}

// ---------------- Conexão ----------------

/** Estado da conexão com o Firebase: 'connecting' | 'online' | 'offline'. */
export async function watchConnection(cb) {
  cb('connecting');
  const { d, db } = await load();
  let seen = false;
  return d.onValue(d.ref(db, '.info/connected'), (s) => {
    if (s.val() === true) seen = true;
    cb(s.val() === true ? 'online' : seen ? 'offline' : 'connecting');
  });
}

// ---------------- Leitura pública ----------------

export async function listMeetings({ includeArchived = false } = {}) {
  const all = Object.values((await read('meetings')) || {});
  return all
    .filter((m) => includeArchived || m.status === 'active')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((m) => ({ id: m.id, name: m.name, status: m.status, phase: D.phase(m), createdAt: m.createdAt, offices: Object.keys(m.offices || {}).length }));
}

function eventOf(prev, next) {
  if (!prev) return 'snapshot';
  if (prev.status !== next.status && next.status === 'archived') return 'meeting_closed';
  const p = prev.currentOffice;
  const n = next.currentOffice;
  if (p?.id !== n?.id) return p ? 'next_office' : 'office_updated';
  if (!n) return 'meeting_updated';
  if (p.status !== n.status) return n.status === 'voting_open' ? 'vote_opened' : n.status === 'closed' ? 'vote_closed' : 'office_updated';
  if (!p.resultsPublished && n.resultsPublished) return 'results_published';
  if (JSON.stringify(p.candidates) !== JSON.stringify(n.candidates)) return 'candidates_updated';
  if (p.turnout.votes !== n.turnout.votes) return 'vote_accepted';
  return 'meeting_updated';
}

/**
 * Acompanha uma reunião em tempo real. Monta o mesmo formato de estado usado pelas telas.
 * Público: lê a reunião e o total de votos; a apuração por candidato só quando liberada.
 * Administrador: lê também a apuração parcial e os resultados selados de todos os cargos.
 */
export async function watchMeeting(meetingId, { admin = false } = {}, onState, onError = () => {}) {
  const { d, db } = await load();
  let meeting = null;
  let counts = {};
  const tallies = {};
  const results = {};
  let last = null;
  const subs = new Map();

  const sub = (path, onData) => {
    if (subs.has(path)) return;
    const stop = d.onValue(
      d.ref(db, path),
      (s) => onData(s.val()),
      () => {
        // Leitura revogada pelas regras (ex.: modo ao vivo desligado): apenas deixa de acompanhar.
        subs.delete(path);
        onData(undefined, true);
      },
    );
    subs.set(path, stop);
  };
  const unsub = (path) => {
    subs.get(path)?.();
    subs.delete(path);
  };

  function view(o) {
    const candidates = D.candidateList(o);
    const sealed = results[o.id];
    const t = admin ? tallies[o.id] || {} : tallies[o.id];
    const present = meeting.expectedParticipants;
    const live = o.status === 'voting_open' && t !== undefined ? D.computeResult(candidates, t, present) : null;
    return {
      id: o.id,
      title: o.title,
      description: o.description || '',
      status: o.status,
      resultsMode: o.resultsMode,
      resultsPublished: Boolean(o.resultsPublished),
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      startedAt: o.startedAt,
      openedAt: o.openedAt,
      closedAt: o.closedAt,
      publishedAt: o.publishedAt,
      candidates,
      turnout: { present, votes: counts[o.id] || 0 },
      live,
      result: sealed?.result || null,
      resultHash: sealed?.resultHash || null,
      results: o.status === 'closed' ? (o.resultsPublished && sealed ? sealed.result : null) : o.resultsMode === 'live' ? live : null,
    };
  }

  function emit() {
    if (!meeting) return;
    const offices = D.officeList(meeting).map(view);
    const cur = offices.find((o) => o.id === meeting.currentOfficeId && o.status !== 'draft') || null;
    const state = {
      id: meeting.id,
      name: meeting.name,
      status: meeting.status,
      phase: D.phase(meeting),
      expectedParticipants: meeting.expectedParticipants,
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
      archivedAt: meeting.archivedAt,
      currentOfficeId: meeting.currentOfficeId || null,
      offices,
      currentOffice: cur,
      history: offices
        .filter((o) => o.status === 'closed')
        .map((o) => ({ id: o.id, title: o.title, closedAt: o.closedAt, resultsPublished: o.resultsPublished, results: o.resultsPublished ? o.result : null })),
    };
    const type = eventOf(last, state);
    last = state;
    onState(state, type);
  }

  /** Público: acompanha apenas o que as regras liberam (parcial ao vivo, resultados publicados). */
  function syncPublicSubs() {
    for (const o of D.officeList(meeting)) {
      const tPath = `tallies/${meetingId}/${o.id}`;
      const rPath = `results/${meetingId}/${o.id}`;
      const wantLive = o.status === 'voting_open' && o.resultsMode === 'live';
      if (wantLive) {
        sub(tPath, (v, denied) => {
          if (denied) delete tallies[o.id];
          else tallies[o.id] = v || {};
          emit();
        });
      } else if (subs.has(tPath)) {
        unsub(tPath);
        delete tallies[o.id];
      }
      if (o.status === 'closed' && o.resultsPublished) {
        sub(rPath, (v, denied) => {
          if (denied || !v) delete results[o.id];
          else results[o.id] = v;
          emit();
        });
      }
    }
  }

  sub(`meetings/${meetingId}`, (v, denied) => {
    if (denied) return onError('denied');
    if (!v) return onError('not_found');
    meeting = v;
    if (!admin) syncPublicSubs();
    emit();
  });
  sub(`counts/${meetingId}`, (v) => {
    counts = v || {};
    emit();
  });
  if (admin) {
    sub(`tallies/${meetingId}`, (v, denied) => {
      if (denied) return onError('denied');
      for (const k of Object.keys(tallies)) delete tallies[k];
      Object.assign(tallies, v || {});
      emit();
    });
    sub(`results/${meetingId}`, (v, denied) => {
      if (denied) return onError('denied');
      for (const k of Object.keys(results)) delete results[k];
      Object.assign(results, v || {});
      emit();
    });
  }
  return () => {
    for (const stop of subs.values()) stop();
    subs.clear();
  };
}

// ---------------- Voto público ----------------

/**
 * Registra UM voto: recibo de criação única + contador da opção (+1) + total (+1),
 * numa única atualização atômica. As regras do banco recusam a operação inteira se a
 * votação não estiver aberta, se a opção for inválida ou se o recibo já existir
 * (retransmissão da mesma confirmação). Nunca envia votos enquanto offline.
 */
export async function castVote(meetingId, officeId, choice, requestId) {
  if (!D.REQUEST_ID_RE.test(requestId)) throw new DataError('invalid_input', 'Voto inválido.');
  const { d, db } = await load();
  if (!connected) throw new DataError('network_error', OFFLINE);
  try {
    await withTimeout(
      d.update(d.ref(db), {
        [`receipts/${meetingId}/${officeId}/${requestId}`]: d.serverTimestamp(),
        [`tallies/${meetingId}/${officeId}/${choice}`]: d.increment(1),
        [`counts/${meetingId}/${officeId}`]: d.increment(1),
      }),
    );
  } catch (e) {
    if (isDenied(e)) throw new DataError('rejected', 'O voto não foi aceito: a votação pode ter sido encerrada.');
    throw translate(e);
  }
}

// ---------------- Administração ----------------

/** Acompanha a sessão: { user, isAdmin }. isAdmin vem de /admins/{uid} (só o próprio usuário lê). */
export async function watchAdmin(cb) {
  const { d, a, db, auth } = await load();
  return a.onAuthStateChanged(auth, async (user) => {
    if (!user) return cb({ user: null, isAdmin: false });
    let isAdmin = false;
    try {
      isAdmin = (await d.get(d.ref(db, `admins/${user.uid}`))).val() === true;
    } catch {
      isAdmin = false;
    }
    cb({ user, isAdmin });
  });
}

export async function signIn(email, password) {
  const { a, auth } = await load();
  try {
    await a.signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    const code = String(e?.code || '');
    if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)) throw new DataError('invalid_login', 'E-mail ou senha incorretos.');
    if (/too-many-requests/.test(code)) throw new DataError('rate_limited', 'Muitas tentativas. Aguarde alguns minutos.');
    throw new DataError('network_error', OFFLINE);
  }
}

export async function signOut() {
  const { a, auth } = await load();
  await a.signOut(auth);
}

const ts = (d) => d.serverTimestamp();

async function requireMeeting(meetingId) {
  const m = await read(`meetings/${meetingId}`);
  if (!m) throw new DataError('not_found', 'Reunião não encontrada.');
  if (m.status !== 'active') throw new DataError('meeting_archived', 'Reunião encerrada: disponível apenas para leitura.');
  return m;
}

function requireOffice(m, officeId) {
  const o = m.offices?.[officeId];
  if (!o) throw new DataError('not_found', 'Cargo não encontrado.');
  return o;
}

async function appendLog(meetingId, entry) {
  await write(({ d, db }) => d.set(d.push(d.ref(db, `log/${meetingId}`)), { ...entry, at: ts(d) }));
}

export async function createMeeting({ name, expectedParticipants }) {
  const id = D.newId('m');
  const meeting = {
    id,
    name: D.cleanText(name, 'Nome da reunião'),
    status: 'active',
    expectedParticipants: D.cleanInt(expectedParticipants, 'Pessoas presentes', 1, D.LIMITS.expectedMax),
    schemaVersion: D.SCHEMA_VERSION,
  };
  await write(({ d, db }) => d.set(d.ref(db, `meetings/${id}`), { ...meeting, createdAt: ts(d), updatedAt: ts(d) }));
  return id;
}

export async function updateMeeting(meetingId, { name, expectedParticipants }) {
  await requireMeeting(meetingId);
  const patch = {
    name: D.cleanText(name, 'Nome'),
    expectedParticipants: D.cleanInt(expectedParticipants, 'Pessoas presentes', 1, D.LIMITS.expectedMax),
  };
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}`), { ...patch, updatedAt: ts(d) }));
}

export async function createOffice(meetingId, { title, description, resultsMode, start = true }) {
  const m = await requireMeeting(meetingId);
  if (Object.keys(m.offices || {}).length >= D.LIMITS.officesPerMeeting) throw new DataError('limit', 'Limite de cargos atingido.');
  const act = D.activeOffice(m);
  if (start && act) throw new DataError('office_in_progress', `O cargo "${act.title}" ainda está em andamento.`);
  if (!D.RESULTS_MODES.includes(resultsMode || 'on_publish')) throw new DataError('invalid_input', 'Modo de resultados inválido.');
  const id = D.newId('o');
  const office = {
    id,
    title: D.cleanText(title, 'Nome do cargo'),
    description: D.cleanText(description, 'Descrição', { optional: true, max: D.LIMITS.descriptionMax }),
    status: start ? 'discussing' : 'draft',
    resultsMode: resultsMode || 'on_publish',
    resultsPublished: false,
  };
  await write(({ d, db }) => {
    const now = ts(d);
    const upd = { [`offices/${id}`]: { ...office, createdAt: now, updatedAt: now, ...(start ? { startedAt: now } : {}) }, updatedAt: now };
    if (start) upd.currentOfficeId = id;
    return d.update(d.ref(db, `meetings/${meetingId}`), upd);
  });
  return id;
}

function assertEditable(o) {
  if (o.status === 'closed') throw new DataError('office_closed', 'Cargo encerrado: resultados são imutáveis.');
  if (o.status === 'voting_open') throw new DataError('voting_in_progress', 'Não é possível alterar candidatos durante a votação.');
}

export async function addCandidate(meetingId, officeId, name) {
  const m = await requireMeeting(meetingId);
  const o = requireOffice(m, officeId);
  assertEditable(o);
  const list = Object.values(o.candidates || {});
  const clean = D.cleanText(name, 'Nome');
  if (list.length >= D.LIMITS.candidatesPerOffice) throw new DataError('limit', 'Limite de candidatos atingido.');
  if (list.some((c) => D.sameName(c.name, clean))) throw new DataError('duplicate_candidate', 'Este nome já está na lista deste cargo.');
  const id = D.newId('c');
  const order = list.reduce((max, c) => Math.max(max, c.order), -1) + 1;
  await write(({ d, db }) =>
    d.update(d.ref(db, `meetings/${meetingId}`), {
      [`offices/${officeId}/candidates/${id}`]: { id, name: clean, order, createdAt: ts(d) },
      [`offices/${officeId}/updatedAt`]: ts(d),
      updatedAt: ts(d),
    }),
  );
}

export async function renameCandidate(meetingId, officeId, candidateId, name) {
  const m = await requireMeeting(meetingId);
  const o = requireOffice(m, officeId);
  assertEditable(o);
  const clean = D.cleanText(name, 'Nome');
  if (Object.values(o.candidates || {}).some((c) => c.id !== candidateId && D.sameName(c.name, clean))) {
    throw new DataError('duplicate_candidate', 'Este nome já está na lista deste cargo.');
  }
  await write(({ d, db }) =>
    d.update(d.ref(db, `meetings/${meetingId}`), { [`offices/${officeId}/candidates/${candidateId}/name`]: clean, [`offices/${officeId}/updatedAt`]: ts(d) }),
  );
}

export async function removeCandidate(meetingId, officeId, candidateId) {
  const m = await requireMeeting(meetingId);
  assertEditable(requireOffice(m, officeId));
  await write(({ d, db }) =>
    d.update(d.ref(db, `meetings/${meetingId}`), { [`offices/${officeId}/candidates/${candidateId}`]: null, [`offices/${officeId}/updatedAt`]: ts(d) }),
  );
}

export async function setResultsMode(meetingId, officeId, mode) {
  const m = await requireMeeting(meetingId);
  if (requireOffice(m, officeId).status === 'closed') throw new DataError('office_closed', 'Cargo encerrado: resultados são imutáveis.');
  if (!D.RESULTS_MODES.includes(mode)) throw new DataError('invalid_input', 'Modo de resultados inválido.');
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}/offices/${officeId}`), { resultsMode: mode, updatedAt: ts(d) }));
}

export async function openVoting(meetingId, officeId) {
  const m = await requireMeeting(meetingId);
  const o = requireOffice(m, officeId);
  if (o.status !== 'discussing') throw new DataError('invalid_state', 'Só é possível abrir a votação de um cargo em discussão.');
  if (!Object.keys(o.candidates || {}).length) throw new DataError('no_candidates', 'Adicione ao menos um nome antes de abrir a votação.');
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}/offices/${officeId}`), { status: 'voting_open', openedAt: ts(d), updatedAt: ts(d) }));
}

/**
 * Encerra a votação e sela o resultado:
 * 1) muda o estado para "encerrada" — a partir daí as regras recusam qualquer voto;
 * 2) lê os contadores finais e calcula a apuração;
 * 3) grava o resultado com selo SHA-256 (gravação única, imutável pelas regras).
 */
export async function closeVoting(meetingId, officeId) {
  const m = await requireMeeting(meetingId);
  const o = requireOffice(m, officeId);
  if (o.status === 'closed') throw new DataError('office_closed', 'Esta votação já foi encerrada.');
  if (o.status !== 'voting_open') throw new DataError('voting_not_open', 'A votação deste cargo não está aberta.');
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}/offices/${officeId}`), { status: 'closed', closedAt: ts(d), updatedAt: ts(d) }));
  return sealResult(meetingId, officeId);
}

/** Calcula e grava o resultado de um cargo encerrado (idempotente: só grava se ainda não existir). */
export async function sealResult(meetingId, officeId) {
  const m = await read(`meetings/${meetingId}`);
  const o = requireOffice(m, officeId);
  if (o.status !== 'closed') throw new DataError('invalid_state', 'O cargo ainda não foi encerrado.');
  const existing = await read(`results/${meetingId}/${officeId}`);
  if (existing) return existing;
  const tallies = (await read(`tallies/${meetingId}/${officeId}`)) || {};
  const result = D.computeResult(D.candidateList(o), tallies, m.expectedParticipants);
  const resultHash = await D.resultHash(meetingId, o, result);
  await write(({ d, db }) => d.set(d.ref(db, `results/${meetingId}/${officeId}`), { result, resultHash, hashVersion: 3, sealedAt: ts(d) }));
  if (o.resultsMode !== 'on_publish') {
    await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}/offices/${officeId}`), { resultsPublished: true, publishedAt: ts(d) }));
  }
  await appendLog(meetingId, { type: 'office_closed', officeId, title: o.title, resultHash });
  return { result, resultHash };
}

export async function publishResults(meetingId, officeId) {
  const m = await requireMeeting(meetingId);
  const o = requireOffice(m, officeId);
  if (o.status !== 'closed') throw new DataError('invalid_state', 'Encerre a votação antes de publicar.');
  if (o.resultsPublished) throw new DataError('already_published', 'Resultados já publicados.');
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}/offices/${officeId}`), { resultsPublished: true, publishedAt: ts(d) }));
  await appendLog(meetingId, { type: 'results_published', officeId });
}

export async function archiveMeeting(meetingId) {
  const m = await requireMeeting(meetingId);
  if (D.officeList(m).some((o) => o.status === 'voting_open')) {
    throw new DataError('voting_in_progress', 'Encerre a votação em andamento antes de encerrar a reunião.');
  }
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}`), { status: 'archived', archivedAt: ts(d), updatedAt: ts(d) }));
  await appendLog(meetingId, { type: 'meeting_archived' });
}

// ---------------- Exportação / importação ----------------

export async function exportMeeting(meetingId) {
  const [meeting, results, counts, tallies, log] = await Promise.all(
    ['meetings', 'results', 'counts', 'tallies', 'log'].map((root) => read(`${root}/${meetingId}`)),
  );
  if (!meeting) throw new DataError('not_found', 'Reunião não encontrada.');
  return D.exportDoc({ meeting, results, counts, tallies, log });
}

/**
 * Importa uma exportação (v3) ou um backup das versões anteriores (v1/v2, servidor Node).
 * Restaura reunião, cargos, candidatos, resultados selados e registro. Os contadores de
 * votações ainda abertas no momento da exportação não podem ser restaurados (as regras só
 * permitem somar votos reais), por isso essas votações voltam sem votos parciais.
 * Nunca sobrescreve uma reunião existente.
 */
export async function importMeeting(doc) {
  const parsed = await D.parseImport(doc);
  const id = parsed.meeting.id;
  if (await read(`meetings/${id}`)) throw new DataError('meeting_exists', 'Já existe uma reunião com este ID. Importação recusada para não sobrescrever resultados.');
  const upd = { [`meetings/${id}`]: parsed.meeting };
  for (const [oid, r] of Object.entries(parsed.results)) upd[`results/${id}/${oid}`] = r;
  for (const [eid, e] of Object.entries(parsed.log || {})) upd[`log/${id}/${eid}`] = e;
  await write(({ d, db }) => d.update(d.ref(db), upd));
  await appendLog(id, { type: 'imported' });
  const openWithVotes = D.officeList(parsed.meeting).filter((o) => o.status === 'voting_open' && parsed.counts?.[o.id]);
  return { id, name: parsed.meeting.name, droppedOpenVotes: openWithVotes.length };
}

// ---------------- QR Code (gerado no navegador) ----------------

let qrLib = null;
export async function qrDataUrl(text) {
  qrLib ??= import(QR_LIB);
  const { toString } = await qrLib;
  const svg = await toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** Endereços públicos baseados no local onde o app está publicado (ex.: GitHub Pages). */
export function pageUrl(page, meetingId) {
  return new URL(`${page}?m=${encodeURIComponent(meetingId)}`, location.href).href;
}
