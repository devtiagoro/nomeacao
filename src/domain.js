'use strict';

const { sha256, newId } = require('./security');

// v2: votação pública (sem credenciais). v1 (com credenciais) é migrado automaticamente.
const SCHEMA_VERSION = 2;
const MEETING_STATUS = ['active', 'archived'];
const OFFICE_STATUS = ['draft', 'discussing', 'voting_open', 'closed'];
const RESULTS_MODES = ['on_publish', 'on_close', 'live'];
const ABSTAIN = 'abstain';

const LIMITS = {
  nameMax: 120,
  descriptionMax: 500,
  expectedMax: 100_000,
  candidatesPerOffice: 100,
  officesPerMeeting: 200,
  votesPerOffice: 100_000,
};

const ID_RE = /^[mopc]_[A-Za-z0-9_-]{12}$/;
// Identificador aleatório de uma confirmação de voto (gerado no navegador). Serve apenas para
// descartar retransmissões da MESMA operação (duplo clique, reenvio após falha de rede).
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();

/** Texto de entrada: normaliza, remove caracteres de controle, valida tamanho. */
function cleanText(value, field, { min = 1, max = LIMITS.nameMax, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return '';
    throw new HttpError(400, 'invalid_input', `Campo "${field}" é obrigatório.`);
  }
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_input', `Campo "${field}" deve ser texto.`);
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < (optional ? 0 : min) || text.length > max) {
    throw new HttpError(400, 'invalid_input', `Campo "${field}" deve ter entre ${min} e ${max} caracteres.`);
  }
  return text;
}

function cleanInt(value, field, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, 'invalid_input', `Campo "${field}" deve ser inteiro entre ${min} e ${max}.`);
  }
  return n;
}

function cleanResultsMode(value, fallback = 'on_publish') {
  if (value === undefined || value === null || value === '') return fallback;
  if (!RESULTS_MODES.includes(value)) throw new HttpError(400, 'invalid_input', 'Modo de resultados inválido.');
  return value;
}

function newMeeting({ name, expectedParticipants }) {
  const t = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('m'),
    name: cleanText(name, 'name'),
    status: 'active',
    // Pessoas presentes informadas pelo administrador. NÃO é o número de votos.
    expectedParticipants: cleanInt(expectedParticipants, 'expectedParticipants', 1, LIMITS.expectedMax),
    createdAt: t,
    updatedAt: t,
    archivedAt: null,
    version: 1,
    currentOfficeId: null,
    offices: [],
  };
}

function newOffice({ title, description, resultsMode }) {
  const t = now();
  return {
    id: newId('o'),
    title: cleanText(title, 'title'),
    description: cleanText(description, 'description', { optional: true, max: LIMITS.descriptionMax }),
    status: 'draft',
    resultsMode: cleanResultsMode(resultsMode),
    resultsPublished: false,
    createdAt: t,
    updatedAt: t,
    startedAt: null,
    openedAt: null,
    closedAt: null,
    publishedAt: null,
    candidates: [],
    requestIds: [],
    tally: { abstain: 0, byCandidate: {} },
    result: null,
    resultHash: null,
  };
}

function newCandidate(name) {
  const t = now();
  return { id: newId('c'), name: cleanText(name, 'name'), createdAt: t, updatedAt: t };
}

function findOffice(m, officeId) {
  const o = m.offices.find((x) => x.id === officeId);
  if (!o) throw new HttpError(404, 'office_not_found', 'Cargo não encontrado.');
  return o;
}

function assertActive(m) {
  if (m.status !== 'active') {
    throw new HttpError(409, 'meeting_archived', 'Reunião encerrada: disponível apenas para leitura.');
  }
}

function assertEditable(o) {
  if (o.status === 'closed') throw new HttpError(409, 'office_closed', 'Cargo encerrado: resultados são imutáveis.');
  if (o.status === 'voting_open') {
    throw new HttpError(409, 'voting_in_progress', 'Não é possível alterar candidatos durante a votação.');
  }
}

function activeOffice(m) {
  return m.offices.find((o) => o.status === 'discussing' || o.status === 'voting_open') || null;
}

/** Fase global da reunião: draft | discussing | voting_open | closed | archived. */
function phase(m) {
  if (m.status === 'archived') return 'archived';
  const cur = m.offices.find((o) => o.id === m.currentOfficeId);
  return cur ? cur.status : 'draft';
}

/** Total de votos registrados no cargo (candidatos + abstenções). */
function totalVotes(o) {
  let n = o.tally.abstain;
  for (const v of Object.values(o.tally.byCandidate)) n += v;
  return n;
}

const pct = (n, d) => (d > 0 ? Math.round((n * 10000) / d) / 100 : 0);

/**
 * Apuração agregada de um cargo. Todos os candidatos aparecem, inclusive com zero votos.
 * Percentuais: sobre votos válidos (sem abstenções) e sobre votos registrados.
 * Votos e pessoas presentes são números independentes: um voto não representa uma pessoa.
 * Nunca declara aprovação automática: apenas indica o(s) mais votado(s) e empate.
 */
function computeResult(m, o) {
  const castVotes = totalVotes(o);
  const abstentions = o.tally.abstain;
  const validVotes = castVotes - abstentions;
  const candidates = o.candidates.map((c) => {
    const votes = o.tally.byCandidate[c.id] || 0;
    return { id: c.id, name: c.name, votes, pctValid: pct(votes, validVotes), pctCast: pct(votes, castVotes) };
  });
  const maxVotes = candidates.reduce((a, c) => Math.max(a, c.votes), 0);
  const leaders = maxVotes > 0 ? candidates.filter((c) => c.votes === maxVotes).map((c) => c.id) : [];
  return {
    candidates,
    castVotes,
    validVotes,
    abstentions,
    abstentionPctCast: pct(abstentions, castVotes),
    presentParticipants: m.expectedParticipants,
    maxVotes,
    leaders,
    tie: leaders.length > 1,
    singleCandidate: candidates.length === 1,
  };
}

/** JSON canônico (chaves ordenadas) para hash estável. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resultHash(meetingId, o) {
  return sha256(
    canonical({
      meetingId,
      officeId: o.id,
      title: o.title,
      openedAt: o.openedAt,
      closedAt: o.closedAt,
      result: o.result,
    }),
  );
}

function resultsVisible(o) {
  return (o.status === 'closed' && o.resultsPublished) || (o.status === 'voting_open' && o.resultsMode === 'live');
}

/** Contadores públicos: pessoas presentes (informado) e votos enviados (contados). */
function turnout(m, o) {
  return { present: m.expectedParticipants, votes: o ? totalVotes(o) : 0 };
}

function publicOffice(m, o) {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    status: o.status,
    resultsMode: o.resultsMode,
    resultsPublished: o.resultsPublished,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    openedAt: o.openedAt,
    closedAt: o.closedAt,
    candidates: o.candidates.map((c) => ({ id: c.id, name: c.name })),
    turnout: turnout(m, o),
    results: resultsVisible(o) ? (o.status === 'closed' ? o.result : computeResult(m, o)) : null,
  };
}

/** Estado público: sem apuração não liberada. */
function publicSnapshot(m) {
  const cur = m.offices.find((o) => o.id === m.currentOfficeId && o.status !== 'draft');
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    phase: phase(m),
    expectedParticipants: m.expectedParticipants,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    archivedAt: m.archivedAt,
    version: m.version,
    currentOffice: cur ? publicOffice(m, cur) : null,
    history: m.offices
      .filter((o) => o.status === 'closed')
      .map((o) => ({
        id: o.id,
        title: o.title,
        closedAt: o.closedAt,
        resultsPublished: o.resultsPublished,
        results: o.resultsPublished ? o.result : null,
      })),
  };
}

/** Estado administrativo: apuração parcial e resultados finais de todos os cargos. */
function adminSnapshot(m) {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    phase: phase(m),
    expectedParticipants: m.expectedParticipants,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    archivedAt: m.archivedAt,
    version: m.version,
    schemaVersion: m.schemaVersion,
    currentOfficeId: m.currentOfficeId,
    offices: m.offices.map((o) => ({
      id: o.id,
      title: o.title,
      description: o.description,
      status: o.status,
      resultsMode: o.resultsMode,
      resultsPublished: o.resultsPublished,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      startedAt: o.startedAt,
      openedAt: o.openedAt,
      closedAt: o.closedAt,
      publishedAt: o.publishedAt,
      candidates: o.candidates.map((c) => ({ id: c.id, name: c.name })),
      turnout: turnout(m, o),
      live: o.status === 'voting_open' ? computeResult(m, o) : null,
      result: o.result,
      resultHash: o.resultHash,
    })),
  };
}

// ---------- Migração de esquema ----------

/**
 * v1 → v2: remove credenciais (participantes, hashes, lista de quem votou).
 * Contagens e resultados encerrados são preservados intactos (o hash continua válido).
 */
function migrateMeeting(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (doc.schemaVersion !== 1) return doc;
  const m = structuredClone(doc);
  delete m.participants;
  delete m.participantSeq;
  for (const o of Array.isArray(m.offices) ? m.offices : []) {
    delete o.voterIds;
    o.requestIds = [];
  }
  m.schemaVersion = 2;
  return m;
}

// ---------- Validação estrutural (antes de gravar e na importação) ----------

function fail(msg) {
  throw new HttpError(400, 'invalid_data', `Dados inválidos: ${msg}`);
}

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isIsoOrNull = (v) => v === null || isIso(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

function validateMeeting(m, { checkHashes = false } = {}) {
  if (!m || typeof m !== 'object') fail('reunião ausente');
  if (m.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion não suportado');
  if (!ID_RE.test(m.id) || !m.id.startsWith('m_')) fail('id da reunião');
  if (!isStr(m.name, LIMITS.nameMax) || !m.name) fail('nome');
  if (!MEETING_STATUS.includes(m.status)) fail('status da reunião');
  if (!Number.isInteger(m.expectedParticipants) || m.expectedParticipants < 1) fail('expectedParticipants');
  if (!isIso(m.createdAt) || !isIso(m.updatedAt) || !isIsoOrNull(m.archivedAt)) fail('datas da reunião');
  if (!Number.isInteger(m.version) || m.version < 1) fail('version');
  if ('participants' in m) fail('campo de credenciais não suportado');
  if (!Array.isArray(m.offices)) fail('listas');
  if (m.offices.length > LIMITS.officesPerMeeting) fail('excesso de cargos');

  const oids = new Set();
  let active = 0;
  for (const o of m.offices) {
    if (!o || !ID_RE.test(o.id) || !o.id.startsWith('o_') || oids.has(o.id)) fail('cargo');
    oids.add(o.id);
    if (!isStr(o.title, LIMITS.nameMax) || !o.title) fail('título do cargo');
    if (!isStr(o.description, LIMITS.descriptionMax)) fail('descrição do cargo');
    if (!OFFICE_STATUS.includes(o.status)) fail('status do cargo');
    if (!RESULTS_MODES.includes(o.resultsMode)) fail('resultsMode');
    if (typeof o.resultsPublished !== 'boolean') fail('resultsPublished');
    for (const k of ['startedAt', 'openedAt', 'closedAt', 'publishedAt']) if (!isIsoOrNull(o[k])) fail(`${k} do cargo`);
    if (!isIso(o.createdAt) || !isIso(o.updatedAt)) fail('datas do cargo');
    if (o.status === 'discussing' || o.status === 'voting_open') active++;
    if (!Array.isArray(o.candidates) || o.candidates.length > LIMITS.candidatesPerOffice) fail('candidatos');
    const cids = new Set();
    for (const c of o.candidates) {
      if (!c || !ID_RE.test(c.id) || !c.id.startsWith('c_') || cids.has(c.id)) fail('candidato');
      if (!isStr(c.name, LIMITS.nameMax) || !c.name) fail('nome de candidato');
      cids.add(c.id);
    }
    if (!o.tally || !Number.isInteger(o.tally.abstain) || o.tally.abstain < 0) fail('tally');
    if (!o.tally.byCandidate || typeof o.tally.byCandidate !== 'object') fail('tally');
    for (const [cid, n] of Object.entries(o.tally.byCandidate)) {
      if (!cids.has(cid) || !Number.isInteger(n) || n < 0) fail('tally por candidato');
    }
    const total = totalVotes(o);
    if (total > LIMITS.votesPerOffice) fail('excesso de votos');
    if (!Array.isArray(o.requestIds) || o.requestIds.length > total) fail('requestIds');
    if (new Set(o.requestIds).size !== o.requestIds.length) fail('requestIds duplicados');
    for (const r of o.requestIds) if (typeof r !== 'string' || !REQUEST_ID_RE.test(r)) fail('requestId');
    if ((o.status === 'draft' || o.status === 'discussing') && total) fail('votos em cargo não aberto');
    if (o.status === 'closed') {
      if (!o.result || !isHash(o.resultHash) || !isIso(o.closedAt)) fail('resultado de cargo encerrado');
      if (checkHashes && resultHash(m.id, o) !== o.resultHash) fail(`hash do resultado do cargo ${o.id} não confere`);
      if (o.result.castVotes !== total) fail('resultado difere dos votos registrados');
    } else if (o.result !== null || o.resultHash !== null) {
      fail('resultado em cargo não encerrado');
    }
  }
  if (active > 1) fail('mais de um cargo ativo');
  if (m.currentOfficeId !== null && !oids.has(m.currentOfficeId)) fail('currentOfficeId');
  return m;
}

module.exports = {
  SCHEMA_VERSION,
  RESULTS_MODES,
  ABSTAIN,
  LIMITS,
  ID_RE,
  REQUEST_ID_RE,
  HttpError,
  now,
  cleanText,
  cleanInt,
  cleanResultsMode,
  newMeeting,
  newOffice,
  newCandidate,
  findOffice,
  assertActive,
  assertEditable,
  activeOffice,
  phase,
  totalVotes,
  computeResult,
  resultHash,
  canonical,
  publicSnapshot,
  adminSnapshot,
  migrateMeeting,
  validateMeeting,
};
