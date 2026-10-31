// NOMEIA — regras de domínio do navegador (puras, sem DOM e sem rede).
// Cédula (escolha única ou múltipla), apuração, CSV e exportação.
// A autoridade sobre quem pode gravar o quê são as regras do Firebase (database.rules.json).

export const ABSTAIN = 'abstain';
export const VOTE_TYPES = ['single', 'multiple'];
export const LIMITS = { nameMax: 120, presentMax: 100_000, candidatesPerOffice: 100 };
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const EXPORT_FORMAT = 'nomeia-export';
export const EXPORT_VERSION = 4;

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

/** Identificador aleatório de uma confirmação de voto (evita contar duas vezes um reenvio). */
export function newRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Texto de entrada: normaliza, remove caracteres de controle, valida tamanho. */
export function cleanText(value, field, { max = LIMITS.nameMax } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('invalid_input', `Preencha o campo "${field}".`);
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > max) throw new DomainError('invalid_input', `"${field}" deve ter entre 1 e ${max} caracteres.`);
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

/** Cargo ainda não encerrado (em preparação, apresentado ou com votação aberta). */
export function activeOffice(meeting) {
  return officeList(meeting).find((o) => o.status !== 'closed') || null;
}

/** Máximo de nomes por cédula: 1 na escolha única. */
export const maxChoicesOf = (office) => (office.voteType === 'multiple' ? office.maxChoices : 1);

/**
 * Converte a seleção da tela em chaves de contagem de UMA cédula.
 * Nenhum nome selecionado = abstenção. Escolha única: exatamente um nome.
 * Múltipla escolha: de 1 até maxChoices nomes distintos.
 */
export function ballotChoices(office, selectedIds) {
  const ids = [...new Set(selectedIds || [])];
  if (!ids.length || (ids.length === 1 && ids[0] === ABSTAIN)) return [ABSTAIN];
  if (ids.includes(ABSTAIN)) throw new DomainError('invalid_ballot', 'Abstenção não pode ser combinada com nomes.');
  const max = maxChoicesOf(office);
  if (ids.length > max) throw new DomainError('invalid_ballot', max === 1 ? 'Escolha apenas um nome.' : `Escolha no máximo ${max} nomes.`);
  const valid = new Set(Object.values(office.candidates || {}).map((c) => c.id));
  if (!ids.every((id) => valid.has(id))) throw new DomainError('invalid_ballot', 'A lista de nomes mudou. Revise sua escolha.');
  return ids;
}

const pct = (n, d) => (d > 0 ? Math.round((n * 10000) / d) / 100 : 0);

/**
 * Apuração de um cargo. Todos os candidatos aparecem, inclusive com zero votos.
 * ballots = cédulas registradas (contador público). Cada cédula conta 1 voto para cada nome marcado,
 * ou 1 abstenção. Percentual de cada nome = votos ÷ cédulas válidas (sem abstenção);
 * na múltipla escolha a soma dos percentuais pode passar de 100%.
 * Nunca declara eleito: apenas indica o(s) mais votado(s) e empate.
 */
export function computeResult(office, tallies, ballots, present) {
  const t = tallies || {};
  const abstentions = Number(t[ABSTAIN] || 0);
  const total = Number(ballots || 0);
  const validBallots = Math.max(0, total - abstentions);
  const list = candidateList(office).map((c) => ({ ...c, votes: Number(t[c.id] || 0) }));
  const maxVotes = list.reduce((a, c) => Math.max(a, c.votes), 0);
  const leaders = maxVotes > 0 ? list.filter((c) => c.votes === maxVotes).map((c) => c.id) : [];
  return {
    voteType: office.voteType,
    maxChoices: maxChoicesOf(office),
    candidates: list.map((c) => ({ ...c, pct: pct(c.votes, validBallots) })),
    ballots: total,
    abstentions,
    validBallots,
    totalVotes: list.reduce((a, c) => a + c.votes, 0),
    present: present ?? null,
    maxVotes,
    leaders,
    tie: leaders.length > 1,
  };
}

// ---------------- CSV ----------------

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n) => String(n).replace('.', ',');
const iso = (t) => (typeof t === 'number' ? new Date(t).toISOString() : '');
export const VOTE_TYPE_LABEL = { single: 'Escolha única', multiple: 'Múltipla escolha' };

const CSV_HEADER = ['reuniao', 'cargo', 'tipo', 'max_escolhas', 'estado', 'aberto_em', 'encerrado_em', 'item', 'nome', 'quantidade', 'pct_cedulas_validas'];

/** CSV (";" e vírgula decimal, compatível com Excel pt-BR) dos cargos encerrados. */
export function resultsCsv(meeting, counts, tallies, officeIds = null) {
  const rows = [CSV_HEADER];
  for (const o of officeList(meeting)) {
    if (o.status !== 'closed' || (officeIds && !officeIds.includes(o.id))) continue;
    const r = computeResult(o, tallies?.[o.id], counts?.[o.id], meeting.expectedParticipants);
    const base = [meeting.name, o.title, VOTE_TYPE_LABEL[o.voteType], r.maxChoices, o.status, iso(o.openedAt), iso(o.closedAt)];
    for (const c of r.candidates) rows.push([...base, 'candidato', c.name, c.votes, num(c.pct)]);
    rows.push([...base, 'abstencao', 'Abstenções', r.abstentions, '']);
    rows.push([...base, 'cedulas', 'Cédulas registradas', r.ballots, '']);
    rows.push([...base, 'presentes', 'Pessoas presentes (informado)', r.present ?? '', '']);
  }
  return '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// ---------------- Exportação ----------------

/** Exportação completa: dados brutos do banco + apuração calculada de cada cargo. */
export function exportDoc({ meeting, counts, tallies }) {
  const results = {};
  for (const o of officeList(meeting)) {
    results[o.id] = { title: o.title, status: o.status, ...computeResult(o, tallies?.[o.id], counts?.[o.id], meeting.expectedParticipants) };
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    meeting,
    counts: counts || {},
    tallies: tallies || {},
    results,
  };
}
