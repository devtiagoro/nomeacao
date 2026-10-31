// NOMEIA — regras de domínio do navegador (puras, sem DOM e sem rede).
// Apuração, selo de integridade (SHA-256), CSV, exportação e importação.
// A autoridade sobre quem pode gravar o quê são as regras do Firebase (database.rules.json).

export const SCHEMA_VERSION = 3;
export const ABSTAIN = 'abstain';
export const RESULTS_MODES = ['on_publish', 'on_close', 'live'];
export const LIMITS = { nameMax: 120, descriptionMax: 500, expectedMax: 100_000, candidatesPerOffice: 100, officesPerMeeting: 200 };
export const ID_RE = /^[mopc]_[A-Za-z0-9_-]{12}$/;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const EXPORT_FORMAT = 'nomeia-export';

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** ID aleatório no formato prefixo_XXXXXXXXXXXX (base64url, 72 bits). */
export function newId(prefix) {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${prefix}_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Identificador aleatório de uma confirmação de voto. */
export function newRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Texto de entrada: normaliza, remove caracteres de controle, valida tamanho. */
export function cleanText(value, field, { min = 1, max = LIMITS.nameMax, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    throw new DomainError('invalid_input', `Preencha o campo "${field}".`);
  }
  if (typeof value !== 'string') throw new DomainError('invalid_input', `Campo "${field}" inválido.`);
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < (optional ? 0 : min) || text.length > max) {
    throw new DomainError('invalid_input', `"${field}" deve ter entre ${optional ? 0 : min} e ${max} caracteres.`);
  }
  return text;
}

export function cleanInt(value, field, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw new DomainError('invalid_input', `"${field}" deve ser um número inteiro entre ${min} e ${max}.`);
  return n;
}

export const sameName = (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }) === 0;

/** Lista de candidatos (objeto do banco) em ordem de cadastro. */
export function candidateList(office) {
  return Object.values(office?.candidates || {})
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Lista de cargos (objeto do banco) em ordem de criação. */
export function officeList(meeting) {
  return Object.values(meeting?.offices || {}).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Fase global da reunião: draft | discussing | voting_open | closed | archived. */
export function phase(m) {
  if (m.status === 'archived') return 'archived';
  const cur = m.offices?.[m.currentOfficeId];
  return cur ? cur.status : 'draft';
}

export function activeOffice(m) {
  return officeList(m).find((o) => o.status === 'discussing' || o.status === 'voting_open') || null;
}

const pct = (n, d) => (d > 0 ? Math.round((n * 10000) / d) / 100 : 0);

/**
 * Apuração a partir dos contadores por opção. Todos os candidatos aparecem, inclusive com zero.
 * Votos e pessoas presentes são independentes: um voto não representa uma pessoa.
 * Nunca declara aprovação automática: apenas indica o(s) mais votado(s) e empate.
 */
export function computeResult(candidates, tallies, presentParticipants) {
  const t = tallies || {};
  const abstentions = Number(t[ABSTAIN] || 0);
  const list = candidates.map((c) => ({ id: c.id, name: c.name, votes: Number(t[c.id] || 0) }));
  const validVotes = list.reduce((a, c) => a + c.votes, 0);
  const castVotes = validVotes + abstentions;
  const out = list.map((c) => ({ ...c, pctValid: pct(c.votes, validVotes), pctCast: pct(c.votes, castVotes) }));
  const maxVotes = out.reduce((a, c) => Math.max(a, c.votes), 0);
  const leaders = maxVotes > 0 ? out.filter((c) => c.votes === maxVotes).map((c) => c.id) : [];
  return {
    candidates: out,
    castVotes,
    validVotes,
    abstentions,
    abstentionPctCast: pct(abstentions, castVotes),
    presentParticipants,
    maxVotes,
    leaders,
    tie: leaders.length > 1,
    singleCandidate: out.length === 1,
  };
}

/** JSON canônico (chaves ordenadas) para hash estável. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Selo do resultado de um cargo encerrado. */
export function resultHash(meetingId, office, result) {
  return sha256Hex(
    canonical({ meetingId, officeId: office.id, title: office.title, openedAt: office.openedAt ?? null, closedAt: office.closedAt ?? null, result }),
  );
}

// ---------------- CSV ----------------

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n) => String(n).replace('.', ',');
const iso = (t) => (typeof t === 'number' ? new Date(t).toISOString() : t || '');

const CSV_HEADER = ['reuniao_id', 'reuniao', 'cargo_id', 'cargo', 'aberto_em', 'encerrado_em', 'tipo', 'opcao_id', 'opcao', 'quantidade', 'pct_validos', 'pct_registrados'];

/** CSV (";" e vírgula decimal, compatível com Excel pt-BR) dos cargos encerrados. */
export function resultsCsv(meeting, results, officeIds = null) {
  const rows = [CSV_HEADER];
  for (const o of officeList(meeting)) {
    const sealed = results?.[o.id];
    if (o.status !== 'closed' || !sealed || (officeIds && !officeIds.includes(o.id))) continue;
    const r = sealed.result;
    const base = [meeting.id, meeting.name, o.id, o.title, iso(o.openedAt), iso(o.closedAt)];
    for (const c of r.candidates) rows.push([...base, 'candidato', c.id, c.name, c.votes, num(c.pctValid), num(c.pctCast)]);
    rows.push([...base, 'abstencao', '', 'Abstenção', r.abstentions, '', num(r.abstentionPctCast)]);
    rows.push([...base, 'total', '', 'Votos registrados', r.castVotes, '', '100']);
    rows.push([...base, 'total', '', 'Votos válidos (sem abstenção)', r.validVotes, '', '']);
    rows.push([...base, 'presenca', '', 'Pessoas presentes (informado)', r.presentParticipants ?? r.expectedParticipants ?? '', '', '']);
    rows.push([...base, 'resumo', '', r.tie ? 'Empate entre os mais votados' : 'Sem empate', r.leaders.length, '', '']);
    rows.push([...base, 'integridade', '', `sha256:${sealed.resultHash}`, '', '', '']);
  }
  return '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// ---------------- Exportação / importação ----------------

export function exportDoc({ meeting, results, counts, tallies, log }) {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meeting,
    results: results || {},
    counts: counts || {},
    tallies: tallies || {},
    log: log || {},
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new DomainError('invalid_data', `Arquivo inválido: ${msg}`);
};

function validateMeetingV3(m) {
  if (!isObj(m) || m.schemaVersion !== SCHEMA_VERSION) fail('versão da reunião');
  if (!/^m_[A-Za-z0-9_-]{12}$/.test(m.id)) fail('id da reunião');
  cleanText(m.name, 'nome');
  if (!['active', 'archived'].includes(m.status)) fail('status');
  cleanInt(m.expectedParticipants, 'pessoas presentes', 1, LIMITS.expectedMax);
  for (const o of officeList(m)) {
    if (!/^o_[A-Za-z0-9_-]{12}$/.test(o.id)) fail('id de cargo');
    if (!['draft', 'discussing', 'voting_open', 'closed'].includes(o.status)) fail('status de cargo');
    for (const c of Object.values(o.candidates || {})) if (!/^c_[A-Za-z0-9_-]{12}$/.test(c.id)) fail('id de candidato');
  }
  if (m.currentOfficeId && !m.offices?.[m.currentOfficeId]) fail('cargo atual');
}

/**
 * Converte um arquivo exportado em dados prontos para gravar no banco.
 * Aceita exportações v3 (Firebase) e v1/v2 (versões anteriores com servidor Node),
 * verificando o selo SHA-256 de cada resultado encerrado.
 */
export async function parseImport(doc) {
  if (!isObj(doc) || doc.format !== EXPORT_FORMAT) fail('não é uma exportação Nomeia');
  if (doc.schemaVersion === SCHEMA_VERSION) {
    const m = doc.meeting;
    validateMeetingV3(m);
    const results = isObj(doc.results) ? doc.results : {};
    for (const o of officeList(m)) {
      if (o.status !== 'closed') continue;
      const r = results[o.id];
      if (!r) fail(`resultado do cargo ${o.id} ausente`);
      if (r.hashVersion === 3 && (await resultHash(m.id, o, r.result)) !== r.resultHash) fail(`selo do cargo ${o.id} não confere`);
    }
    return { meeting: m, results, counts: doc.counts || {}, tallies: doc.tallies || {}, log: doc.log || {} };
  }
  if (doc.schemaVersion === 1 || doc.schemaVersion === 2) return convertLegacy(doc.meeting);
  fail('versão de esquema não suportada');
}

/** Exportação/backup do servidor Node (v1/v2) → estrutura do Firebase (v3). */
async function convertLegacy(old) {
  if (!isObj(old) || !Array.isArray(old.offices)) fail('reunião antiga');
  const ms = (v) => (v ? Date.parse(v) : undefined);
  const offices = {};
  const results = {};
  const tallies = {};
  const counts = {};
  for (const o of old.offices) {
    if (o.status === 'closed') {
      const legacyHash = await sha256Hex(
        canonical({ meetingId: old.id, officeId: o.id, title: o.title, openedAt: o.openedAt, closedAt: o.closedAt, result: o.result }),
      );
      if (legacyHash !== o.resultHash) fail(`selo do cargo ${o.id} não confere`);
      results[o.id] = { result: o.result, resultHash: o.resultHash, hashVersion: 2 };
    }
    const t = { ...(o.tally?.byCandidate || {}) };
    if (o.tally?.abstain) t[ABSTAIN] = o.tally.abstain;
    const total = Object.values(t).reduce((a, n) => a + n, 0);
    if (total) {
      tallies[o.id] = t;
      counts[o.id] = total;
    }
    const candidates = {};
    o.candidates.forEach((c, i) => {
      candidates[c.id] = { id: c.id, name: c.name, order: i, createdAt: ms(c.createdAt) };
    });
    offices[o.id] = JSON.parse(
      JSON.stringify({
        id: o.id,
        title: o.title,
        description: o.description || '',
        status: o.status,
        resultsMode: o.resultsMode,
        resultsPublished: o.resultsPublished,
        createdAt: ms(o.createdAt),
        updatedAt: ms(o.updatedAt),
        startedAt: ms(o.startedAt),
        openedAt: ms(o.openedAt),
        closedAt: ms(o.closedAt),
        publishedAt: ms(o.publishedAt),
        candidates,
      }),
    );
  }
  const meeting = JSON.parse(
    JSON.stringify({
      id: old.id,
      name: old.name,
      status: old.status,
      expectedParticipants: old.expectedParticipants,
      createdAt: ms(old.createdAt),
      updatedAt: ms(old.updatedAt),
      archivedAt: ms(old.archivedAt),
      schemaVersion: SCHEMA_VERSION,
      currentOfficeId: old.currentOfficeId || undefined,
      offices,
    }),
  );
  validateMeetingV3(meeting);
  return { meeting, results, counts, tallies, log: {} };
}
