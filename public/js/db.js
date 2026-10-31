// NOMEIA — acesso ao Firebase Realtime Database (fonte compartilhada, em tempo real).
// O SDK oficial é carregado do CDN do Google. Nenhuma regra de permissão vive aqui:
// as validações deste arquivo melhoram a experiência, mas quem decide é database.rules.json.
//
// Estrutura no banco:
//   current                         reunião em andamento (as telas públicas seguem este ponteiro)
//   meetings/{m}                    reunião, cargos e candidatos
//   counts/{m}/{o}                  cédulas registradas
//   tallies/{m}/{o}/{c|abstain}     votos por candidato e abstenções
//   receipts/{m}/{o}/{id}           uma marca por confirmação (evita contar reenvio duas vezes)

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

const OFFLINE = 'Sem conexão. Verifique a internet e tente novamente.';

let loading = null;
let connected = false;

/** Carrega o SDK e inicializa o app uma única vez. */
function load() {
  if (!configured) return Promise.reject(new DataError('not_configured', 'Firebase não configurado (js/firebase-config.js).'));
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

// ---------------- Tempo real ----------------

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

/** Acompanha qual reunião está em andamento (id ou null). */
export async function watchCurrent(cb) {
  const { d, db } = await load();
  return d.onValue(d.ref(db, 'current'), (s) => cb(s.val() || null));
}

/**
 * Acompanha uma reunião em tempo real e entrega um estado pronto para as telas.
 * Público: reunião + total de cédulas; votos por candidato só com resultado liberado
 * (ao vivo, se o administrador permitir, ou após o encerramento).
 * Administrador: lê também a apuração parcial de todos os cargos.
 */
export async function watchMeeting(meetingId, { admin = false } = {}, onState, onError = () => {}) {
  const { d, db } = await load();
  let meeting = null;
  let counts = {};
  const tallies = {};
  const subs = new Map();

  const sub = (path, onData) => {
    if (subs.has(path)) return;
    const stop = d.onValue(
      d.ref(db, path),
      (s) => onData(s.val()),
      () => {
        // Leitura revogada pelas regras (ex.: parcial ao vivo desligada): deixa de acompanhar.
        subs.delete(path);
        onData(undefined, true);
      },
    );
    subs.set(path, stop);
  };

  function view(o) {
    const visible = admin || o.status === 'closed' || (o.status === 'voting_open' && o.liveResults === true);
    const t = tallies[o.id];
    const result = t !== undefined || (admin && o.status !== 'draft') ? D.computeResult(o, t, counts[o.id], meeting.expectedParticipants) : null;
    return {
      id: o.id,
      title: o.title,
      voteType: o.voteType,
      maxChoices: D.maxChoicesOf(o),
      status: o.status,
      liveResults: o.liveResults === true,
      createdAt: o.createdAt,
      presentedAt: o.presentedAt,
      openedAt: o.openedAt,
      closedAt: o.closedAt,
      candidates: D.candidateList(o),
      ballots: counts[o.id] || 0,
      result: visible ? result : null,
    };
  }

  function emit() {
    if (!meeting) return;
    const offices = D.officeList(meeting).map(view);
    onState({
      id: meeting.id,
      name: meeting.name,
      expectedParticipants: meeting.expectedParticipants,
      createdAt: meeting.createdAt,
      offices,
      // Cargo em preparação não aparece nas telas públicas até "Apresentar".
      currentOffice: offices.find((o) => o.id === meeting.currentOfficeId && (admin || o.status !== 'draft')) || null,
    });
  }

  /** Público: acompanha a apuração apenas dos cargos em que as regras a liberam. */
  function syncPublicTallies() {
    for (const o of D.officeList(meeting)) {
      const path = `tallies/${meetingId}/${o.id}`;
      const visible = o.status === 'closed' || (o.status === 'voting_open' && o.liveResults === true);
      if (visible) {
        sub(path, (v, denied) => {
          if (denied) delete tallies[o.id];
          else tallies[o.id] = v || {};
          emit();
        });
      } else if (subs.has(path)) {
        subs.get(path)();
        subs.delete(path);
        delete tallies[o.id];
      }
    }
  }

  sub(`meetings/${meetingId}`, (v, denied) => {
    if (denied || !v) return onError(denied ? 'denied' : 'not_found');
    meeting = v;
    if (!admin) syncPublicTallies();
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
  }
  return () => {
    for (const stop of subs.values()) stop();
    subs.clear();
  };
}

// ---------------- Voto público ----------------

/**
 * Registra UMA cédula numa única atualização atômica: marca de confirmação (criação única),
 * +1 para cada nome escolhido (ou +1 abstenção) e +1 no total de cédulas.
 * As regras recusam a operação inteira se a votação não estiver aberta, se algum nome
 * não existir ou se a marca já existir (reenvio da mesma confirmação).
 * Nunca envia votos enquanto offline.
 */
export async function castBallot(meetingId, officeId, choices, requestId) {
  if (!D.REQUEST_ID_RE.test(requestId) || !choices.length) throw new DataError('invalid_input', 'Voto inválido.');
  const { d, db } = await load();
  if (!connected) throw new DataError('network_error', OFFLINE);
  const upd = {
    [`receipts/${meetingId}/${officeId}/${requestId}`]: d.serverTimestamp(),
    [`counts/${meetingId}/${officeId}`]: d.increment(1),
  };
  for (const c of choices) upd[`tallies/${meetingId}/${officeId}/${c}`] = d.increment(1);
  try {
    await withTimeout(d.update(d.ref(db), upd));
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

export async function listMeetings() {
  return Object.values((await read('meetings')) || {})
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt, offices: Object.keys(m.offices || {}).length }));
}

/** Cria a reunião e a torna a reunião em andamento (telas públicas mudam sozinhas). */
export async function createMeeting({ name, expectedParticipants }) {
  const id = D.newId('m');
  const meeting = {
    id,
    name: D.cleanText(name, 'Nome da reunião'),
    expectedParticipants: D.cleanInt(expectedParticipants, 'Pessoas presentes', 1, D.LIMITS.presentMax),
  };
  await write(({ d, db }) => d.update(d.ref(db), { [`meetings/${id}`]: { ...meeting, createdAt: ts(d) }, current: id }));
  return id;
}

/** Retoma uma reunião existente como a reunião em andamento. */
export async function setCurrentMeeting(meetingId) {
  await write(({ d, db }) => d.set(d.ref(db, 'current'), meetingId));
}

export async function setPresent(meetingId, expectedParticipants) {
  const n = D.cleanInt(expectedParticipants, 'Pessoas presentes', 1, D.LIMITS.presentMax);
  await write(({ d, db }) => d.set(d.ref(db, `meetings/${meetingId}/expectedParticipants`), n));
}

async function requireOffice(meetingId, officeId) {
  const o = await read(`meetings/${meetingId}/offices/${officeId}`);
  if (!o) throw new DataError('not_found', 'Cargo não encontrado.');
  return o;
}

/** Cria o cargo em preparação: só aparece nas telas públicas depois de "Apresentar". */
export async function createOffice(meetingId, { title, voteType, maxChoices }) {
  const m = await read(`meetings/${meetingId}`);
  if (!m) throw new DataError('not_found', 'Reunião não encontrada.');
  const act = D.activeOffice(m);
  if (act) throw new DataError('office_in_progress', `Encerre o cargo "${act.title}" antes de criar outro.`);
  if (!D.VOTE_TYPES.includes(voteType)) throw new DataError('invalid_input', 'Tipo de votação inválido.');
  const id = D.newId('o');
  const office = {
    id,
    title: D.cleanText(title, 'Nome do cargo'),
    voteType,
    maxChoices: voteType === 'multiple' ? D.cleanInt(maxChoices, 'Máximo de escolhas', 2, D.LIMITS.candidatesPerOffice) : 1,
    status: 'draft',
    liveResults: false,
  };
  await write(({ d, db }) => d.update(d.ref(db, `meetings/${meetingId}`), { [`offices/${id}`]: { ...office, createdAt: ts(d) }, currentOfficeId: id }));
  return id;
}

function assertEditable(o) {
  if (o.status !== 'draft' && o.status !== 'discussing') throw new DataError('locked', 'A lista de nomes não pode mudar depois que a votação é aberta.');
}

export async function addCandidate(meetingId, officeId, name) {
  const o = await requireOffice(meetingId, officeId);
  assertEditable(o);
  const list = Object.values(o.candidates || {});
  const clean = D.cleanText(name, 'Nome');
  if (list.length >= D.LIMITS.candidatesPerOffice) throw new DataError('limit', 'Limite de nomes atingido.');
  if (list.some((c) => D.sameName(c.name, clean))) throw new DataError('duplicate_candidate', 'Este nome já está na lista.');
  const id = D.newId('c');
  const order = list.reduce((max, c) => Math.max(max, c.order), -1) + 1;
  await write(({ d, db }) => d.set(d.ref(db, `meetings/${meetingId}/offices/${officeId}/candidates/${id}`), { id, name: clean, order }));
}

export async function renameCandidate(meetingId, officeId, candidateId, name) {
  const o = await requireOffice(meetingId, officeId);
  assertEditable(o);
  const clean = D.cleanText(name, 'Nome');
  if (Object.values(o.candidates || {}).some((c) => c.id !== candidateId && D.sameName(c.name, clean))) {
    throw new DataError('duplicate_candidate', 'Este nome já está na lista.');
  }
  await write(({ d, db }) => d.set(d.ref(db, `meetings/${meetingId}/offices/${officeId}/candidates/${candidateId}/name`), clean));
}

export async function removeCandidate(meetingId, officeId, candidateId) {
  assertEditable(await requireOffice(meetingId, officeId));
  await write(({ d, db }) => d.remove(d.ref(db, `meetings/${meetingId}/offices/${officeId}/candidates/${candidateId}`)));
}

const officeRef = (d, db, meetingId, officeId) => d.ref(db, `meetings/${meetingId}/offices/${officeId}`);

/** Mostra o cargo e os nomes na apresentação e nos celulares (votação ainda fechada). */
export async function presentOffice(meetingId, officeId) {
  const o = await requireOffice(meetingId, officeId);
  if (o.status !== 'draft') throw new DataError('invalid_state', 'Este cargo já foi apresentado.');
  await write(({ d, db }) => d.update(officeRef(d, db, meetingId, officeId), { status: 'discussing', presentedAt: ts(d) }));
}

export async function openVoting(meetingId, officeId) {
  const o = await requireOffice(meetingId, officeId);
  if (o.status !== 'discussing') throw new DataError('invalid_state', 'Apresente o cargo antes de abrir a votação.');
  const n = Object.keys(o.candidates || {}).length;
  if (!n) throw new DataError('no_candidates', 'Adicione ao menos um nome antes de abrir a votação.');
  if (o.voteType === 'multiple' && o.maxChoices > n) {
    throw new DataError('invalid_state', `O máximo de escolhas (${o.maxChoices}) é maior que a quantidade de nomes (${n}).`);
  }
  await write(({ d, db }) => d.update(officeRef(d, db, meetingId, officeId), { status: 'voting_open', openedAt: ts(d) }));
}

/** Liga/desliga o resultado parcial ao vivo na apresentação e nos celulares. */
export async function setLiveResults(meetingId, officeId, on) {
  await write(({ d, db }) => d.set(d.ref(db, `meetings/${meetingId}/offices/${officeId}/liveResults`), Boolean(on)));
}

/**
 * Encerra a votação. A partir daí as regras recusam votos e qualquer alteração do cargo:
 * contadores e nomes ficam definitivos e o resultado passa a ser público.
 */
export async function closeVoting(meetingId, officeId) {
  const o = await requireOffice(meetingId, officeId);
  if (o.status !== 'voting_open') throw new DataError('invalid_state', 'A votação deste cargo não está aberta.');
  await write(({ d, db }) => d.update(officeRef(d, db, meetingId, officeId), { status: 'closed', closedAt: ts(d) }));
}

export async function exportMeeting(meetingId) {
  const [meeting, counts, tallies] = await Promise.all(['meetings', 'counts', 'tallies'].map((root) => read(`${root}/${meetingId}`)));
  if (!meeting) throw new DataError('not_found', 'Reunião não encontrada.');
  return D.exportDoc({ meeting, counts, tallies });
}

// ---------------- QR Code (gerado no navegador) ----------------

let qrLib = null;
export async function qrDataUrl(text) {
  qrLib ??= import(QR_LIB);
  const { toString } = await qrLib;
  const svg = await toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** Endereço público de uma página, relativo ao local publicado (ex.: GitHub Pages). */
export const pageUrl = (page) => new URL(page, location.href).href;
