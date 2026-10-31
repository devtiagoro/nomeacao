'use strict';

// Regras de domínio executadas no navegador (public/js/domain.js): apuração, selo, CSV, importação.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let D;
test.before(async () => {
  D = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'domain.js')).href);
});

const cands = [
  { id: 'c_AAAAAAAAAAAA', name: 'Ana' },
  { id: 'c_BBBBBBBBBBBB', name: 'Bruno' },
  { id: 'c_CCCCCCCCCCCC', name: 'Carla' },
];

test('contagens e percentuais corretos, com empate e candidato com zero votos', () => {
  const r = D.computeResult(cands, { c_AAAAAAAAAAAA: 2, c_BBBBBBBBBBBB: 2, abstain: 1 }, 8);
  assert.equal(r.castVotes, 5);
  assert.equal(r.validVotes, 4);
  assert.equal(r.abstentions, 1);
  assert.equal(r.abstentionPctCast, 20);
  assert.equal(r.presentParticipants, 8);
  assert.deepEqual(
    r.candidates.map((c) => [c.name, c.votes, c.pctValid, c.pctCast]),
    [
      ['Ana', 2, 50, 40],
      ['Bruno', 2, 50, 40],
      ['Carla', 0, 0, 0],
    ],
  );
  assert.equal(r.tie, true);
  assert.deepEqual(r.leaders, ['c_AAAAAAAAAAAA', 'c_BBBBBBBBBBBB']);
  assert.equal('elected' in r || 'approved' in r, false, 'nunca declara eleito');
});

test('percentual com dízima, sem votos e candidatura única', () => {
  const r = D.computeResult(cands.slice(0, 2), { c_AAAAAAAAAAAA: 2, c_BBBBBBBBBBBB: 1 }, 3);
  assert.deepEqual([r.candidates[0].pctValid, r.candidates[1].pctValid, r.tie], [66.67, 33.33, false]);
  const empty = D.computeResult(cands.slice(0, 1), null, 4);
  assert.deepEqual([empty.castVotes, empty.leaders, empty.candidates[0].pctValid, empty.singleCandidate], [0, [], 0, true]);
});

test('votos e pessoas presentes são independentes (votos repetidos permitidos)', () => {
  const r = D.computeResult(cands.slice(0, 1), { c_AAAAAAAAAAAA: 9, abstain: 3 }, 2);
  assert.equal(r.castVotes, 12);
  assert.equal(r.presentParticipants, 2);
});

test('selo SHA-256 estável e sensível a qualquer alteração', async () => {
  const office = { id: 'o_AAAAAAAAAAAA', title: 'Presidente', openedAt: 1, closedAt: 2 };
  const result = D.computeResult(cands, { c_AAAAAAAAAAAA: 1 }, 3);
  const h1 = await D.resultHash('m_AAAAAAAAAAAA', office, result);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(await D.resultHash('m_AAAAAAAAAAAA', office, structuredClone(result)), h1);
  const tampered = structuredClone(result);
  tampered.candidates[0].votes = 99;
  assert.notEqual(await D.resultHash('m_AAAAAAAAAAAA', office, tampered), h1);
});

function sampleMeeting() {
  return {
    id: 'm_AAAAAAAAAAAA',
    name: '=Assembleia; "geral"',
    status: 'active',
    expectedParticipants: 5,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 3,
    currentOfficeId: 'o_AAAAAAAAAAAA',
    offices: {
      o_AAAAAAAAAAAA: {
        id: 'o_AAAAAAAAAAAA',
        title: 'Presidente',
        status: 'closed',
        resultsMode: 'on_publish',
        resultsPublished: true,
        createdAt: 1,
        openedAt: 1_760_000_000_000,
        closedAt: 1_760_000_060_000,
        candidates: {
          c_AAAAAAAAAAAA: { id: 'c_AAAAAAAAAAAA', name: 'Ana', order: 0 },
          c_BBBBBBBBBBBB: { id: 'c_BBBBBBBBBBBB', name: 'Bruno', order: 1 },
        },
      },
    },
  };
}

async function sealed(meeting) {
  const o = meeting.offices.o_AAAAAAAAAAAA;
  const result = D.computeResult(D.candidateList(o), { c_AAAAAAAAAAAA: 1, abstain: 1 }, meeting.expectedParticipants);
  return { o_AAAAAAAAAAAA: { result, resultHash: await D.resultHash(meeting.id, o, result), hashVersion: 3 } };
}

test('CSV distingue abstenções, válidos e presentes; protege contra injeção de fórmulas', async () => {
  const m = sampleMeeting();
  const csv = D.resultsCsv(m, await sealed(m));
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /abstencao;;Abstenção;1;/);
  assert.match(csv, /Votos registrados;2;/);
  assert.match(csv, /Votos válidos \(sem abstenção\);1;/);
  assert.match(csv, /Pessoas presentes \(informado\);5;/);
  assert.match(csv, /candidato;c_BBBBBBBBBBBB;Bruno;0;0;0/, 'candidato com zero votos');
  assert.match(csv, /"'=Assembleia; ""geral"""/, 'fórmula neutralizada e aspas escapadas');
  assert.match(csv, /2025-10-09T08:53:20.000Z/, 'datas em ISO');
});

test('exportar e reimportar preserva IDs e histórico; arquivo adulterado é recusado', async () => {
  const meeting = sampleMeeting();
  const results = await sealed(meeting);
  const doc = JSON.parse(JSON.stringify(D.exportDoc({ meeting, results, counts: { o_AAAAAAAAAAAA: 2 } })));
  assert.equal(doc.format, 'nomeia-export');
  assert.equal(doc.schemaVersion, 3);
  const back = await D.parseImport(doc);
  assert.deepEqual(back.meeting, meeting);
  assert.deepEqual(back.results, results);

  const tampered = structuredClone(doc);
  tampered.results.o_AAAAAAAAAAAA.result.candidates[0].votes = 50;
  await assert.rejects(D.parseImport(tampered), /selo/);
  await assert.rejects(D.parseImport({ format: 'outra-coisa' }), /não é uma exportação/);
  const badId = structuredClone(doc);
  badId.meeting.id = 'x';
  await assert.rejects(D.parseImport(badId), /id da reunião/);
});

test('backups da versão anterior (servidor Node, v2) são convertidos com o selo verificado', async () => {
  const result = { candidates: [{ id: 'c_LEGACYcand01', name: 'Ana', votes: 1, pctValid: 100, pctCast: 50 }], castVotes: 2, validVotes: 1, abstentions: 1 };
  const office = {
    id: 'o_LEGACYoff001',
    title: 'Presidente',
    description: '',
    status: 'closed',
    resultsMode: 'on_close',
    resultsPublished: true,
    createdAt: '2026-10-31T12:00:00.000Z',
    updatedAt: '2026-10-31T12:00:00.000Z',
    openedAt: '2026-10-31T12:00:00.000Z',
    closedAt: '2026-10-31T12:05:00.000Z',
    candidates: [{ id: 'c_LEGACYcand01', name: 'Ana', createdAt: '2026-10-31T12:00:00.000Z' }],
    requestIds: [],
    tally: { abstain: 1, byCandidate: { c_LEGACYcand01: 1 } },
    result,
  };
  office.resultHash = await D.sha256Hex(
    D.canonical({ meetingId: 'm_LEGACYabcdef', officeId: office.id, title: office.title, openedAt: office.openedAt, closedAt: office.closedAt, result }),
  );
  const legacy = {
    format: 'nomeia-export',
    schemaVersion: 2,
    meeting: {
      schemaVersion: 2,
      id: 'm_LEGACYabcdef',
      name: 'Reunião antiga',
      status: 'active',
      expectedParticipants: 3,
      createdAt: '2026-10-31T12:00:00.000Z',
      updatedAt: '2026-10-31T12:00:00.000Z',
      archivedAt: null,
      version: 4,
      currentOfficeId: office.id,
      offices: [office],
    },
    ledger: [],
  };
  const out = await D.parseImport(legacy);
  assert.equal(out.meeting.schemaVersion, 3);
  assert.equal(out.meeting.offices.o_LEGACYoff001.candidates.c_LEGACYcand01.name, 'Ana');
  assert.equal(out.results.o_LEGACYoff001.resultHash, office.resultHash);
  assert.equal(out.results.o_LEGACYoff001.hashVersion, 2);
  assert.deepEqual(out.tallies.o_LEGACYoff001, { c_LEGACYcand01: 1, abstain: 1 });

  const tampered = structuredClone(legacy);
  tampered.meeting.offices[0].result.castVotes = 99;
  await assert.rejects(D.parseImport(tampered), /selo/);
});

test('IDs e identificadores de confirmação aleatórios no formato aceito pelas regras', () => {
  const ids = new Set(Array.from({ length: 200 }, () => D.newId('m')));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^m_[A-Za-z0-9_-]{12}$/);
  assert.match(D.newRequestId(), D.REQUEST_ID_RE);
});

test('validação de texto: normaliza, remove controles e limita tamanho', () => {
  assert.equal(D.cleanText('  Nome\u0000com‮controle ', 'x'), 'Nome com controle');
  assert.throws(() => D.cleanText('', 'Nome'), /Preencha/);
  assert.throws(() => D.cleanText('x'.repeat(121), 'Nome'), /entre 1 e 120/);
  assert.throws(() => D.cleanInt(0, 'Presentes', 1, 10), /inteiro/);
  assert.equal(D.sameName('ANA', 'ana'), true);
});
