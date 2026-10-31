'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/domain');
const { startServer, setupMeeting, newOffice, tmpDir, rid } = require('./helpers');
const { Store } = require('../src/store');

const quietLog = { info() {}, warn() {}, error() {} };

test('votos, registros e histórico persistem após reiniciar o servidor', async () => {
  const dataDir = tmpDir();
  let srv = await startServer({ dataDir });
  await srv.client.login();
  const s = await setupMeeting(srv.client);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const firstId = rid();
  await srv.client.vote(s.meetingId, s.officeId, s.cands[0].id, firstId);
  await srv.client.vote(s.meetingId, s.officeId, s.cands[0].id);
  await srv.client.vote(s.meetingId, s.officeId, 'abstain');
  await srv.app.close();

  srv = await startServer({ dataDir });
  await srv.client.login();
  let office = (await srv.client.admin('GET', s.meetingId, '')).body.offices[0];
  assert.equal(office.status, 'voting_open');
  assert.equal(office.live.castVotes, 3);
  assert.equal(office.live.abstentions, 1);

  // A proteção contra retransmissão também sobrevive ao reinício.
  assert.equal((await srv.client.vote(s.meetingId, s.officeId, s.cands[0].id, firstId)).body.status, 'duplicate');
  assert.equal((await srv.client.vote(s.meetingId, s.officeId, s.cands[1].id)).status, 201);

  const hash = (await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`)).body.offices[0].resultHash;
  await srv.app.close();

  srv = await startServer({ dataDir });
  await srv.client.login();
  office = (await srv.client.admin('GET', s.meetingId, '')).body.offices[0];
  assert.equal(office.status, 'closed');
  assert.equal(office.resultHash, hash);
  assert.equal(office.result.castVotes, 4);
  const ledger = await srv.app.store.readLedger(s.meetingId);
  assert.equal(ledger[0].type, 'office_closed');
  assert.equal(Store.verifyLedger(ledger), true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'meetings', `${s.meetingId}.json`), 'utf8'));
  assert.equal(onDisk.schemaVersion, 2);
  assert.equal('participants' in onDisk, false);
  await srv.app.close();
});

test('arquivo corrompido é recuperado do backup mais recente; temporários são descartados', async () => {
  const dataDir = tmpDir();
  let srv = await startServer({ dataDir });
  await srv.client.login();
  const s = await setupMeeting(srv.client);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await srv.client.vote(s.meetingId, s.officeId, s.cands[0].id);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  await srv.app.close();

  const file = path.join(dataDir, 'meetings', `${s.meetingId}.json`);
  fs.writeFileSync(file, '{ "corrompido": ');
  const tmp = path.join(dataDir, 'meetings', `.${s.meetingId}.json.abc123.tmp`);
  fs.writeFileSync(tmp, 'parcial');

  srv = await startServer({ dataDir, log: quietLog });
  await srv.client.login();
  const office = (await srv.client.admin('GET', s.meetingId, '')).body.offices[0];
  assert.equal(office.status, 'closed');
  assert.equal(office.result.castVotes, 1);
  assert.equal(fs.existsSync(tmp), false);
  await srv.app.close();
});

test('exportar e reimportar preserva IDs e histórico; importação nunca sobrescreve', async () => {
  const a = await startServer();
  await a.client.login();
  const s = await setupMeeting(a.client);
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await a.client.vote(s.meetingId, s.officeId, s.cands[0].id);
  await a.client.vote(s.meetingId, s.officeId, 'abstain');
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const b2 = await newOffice(a.client, s.meetingId, 'Tesoureiro', ['Ana', 'Davi']);
  await a.client.admin('POST', s.meetingId, `/offices/${b2.officeId}/open`);
  await a.client.vote(s.meetingId, b2.officeId, b2.cands[1].id);
  await a.client.admin('POST', s.meetingId, `/offices/${b2.officeId}/close`);

  const exp = await a.client.admin('GET', s.meetingId, '/export.json');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  const doc = exp.body;
  assert.equal(doc.format, 'nomeia-export');
  assert.equal(doc.schemaVersion, 2);
  assert.equal((await a.client.req('POST', '/api/admin/import', doc)).status, 409);
  const original = (await a.client.admin('GET', s.meetingId, '')).body;
  await a.app.close();

  const b = await startServer();
  await b.client.login();
  const imp = await b.client.req('POST', '/api/admin/import', doc);
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.id, s.meetingId);
  const copy = (await b.client.admin('GET', s.meetingId, '')).body;
  assert.deepEqual(
    copy.offices.map((o) => [o.id, o.title, o.status, o.resultHash, o.result]),
    original.offices.map((o) => [o.id, o.title, o.status, o.resultHash, o.result]),
  );
  assert.equal((await b.app.store.readLedger(s.meetingId)).length, doc.ledger.length);
  assert.deepEqual((await b.client.admin('GET', s.meetingId, '/export.json')).body.meeting, doc.meeting);
  await b.app.close();
});

test('importação rejeita arquivos adulterados ou inválidos', async () => {
  const a = await startServer();
  await a.client.login();
  const s = await setupMeeting(a.client);
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await a.client.vote(s.meetingId, s.officeId, s.cands[0].id);
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const doc = (await a.client.admin('GET', s.meetingId, '/export.json')).body;
  await a.app.close();

  const b = await startServer();
  await b.client.login();
  const tamper = structuredClone(doc);
  tamper.meeting.offices[0].result.candidates[1].votes = 50;
  const r = await b.client.req('POST', '/api/admin/import', tamper);
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /hash|resultado/);
  const badTally = structuredClone(doc);
  badTally.meeting.offices[0].tally.abstain = 7;
  assert.equal((await b.client.req('POST', '/api/admin/import', badTally)).status, 400);
  const badLedger = structuredClone(doc);
  badLedger.ledger[0].resultHash = '0'.repeat(64);
  assert.equal((await b.client.req('POST', '/api/admin/import', badLedger)).status, 400);
  assert.equal((await b.client.req('POST', '/api/admin/import', { format: 'outra-coisa' })).status, 400);
  assert.equal((await b.client.req('GET', '/api/admin/meetings')).body.length, 0);
  await b.app.close();
});

test('backups versionados mantêm os mais recentes e nunca apagam o último', async () => {
  const srv = await startServer({ backupKeep: 5 });
  await srv.client.login();
  const s = await setupMeeting(srv.client);
  for (let i = 0; i < 8; i++) assert.equal((await srv.client.admin('POST', s.meetingId, '/backup')).status, 201);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await srv.client.vote(s.meetingId, s.officeId, s.cands[0].id);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const list = (await srv.client.admin('GET', s.meetingId, '/backups')).body.backups;
  assert.equal(list.length, 5);
  assert.match(list[list.length - 1], /office-closed/);
  const newest = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'backups', s.meetingId, list[list.length - 1]), 'utf8'));
  assert.equal(newest.meeting.offices[0].result.castVotes, 1, 'último backup contém a última votação');
  await srv.app.close();
});

// ---------- Migração de reuniões criadas com credenciais (esquema v1) ----------

function legacyMeeting() {
  const t = '2026-10-31T12:00:00.000Z';
  const office = {
    id: 'o_LEGACYoff001',
    title: 'Presidente',
    description: '',
    status: 'closed',
    resultsMode: 'on_close',
    resultsPublished: true,
    createdAt: t,
    updatedAt: t,
    startedAt: t,
    openedAt: t,
    closedAt: t,
    publishedAt: t,
    candidates: [{ id: 'c_LEGACYcand01', name: 'Ana', createdAt: t, updatedAt: t }],
    voterIds: ['p_LEGACYpart01', 'p_LEGACYpart02'],
    tally: { abstain: 1, byCandidate: { c_LEGACYcand01: 1 } },
    result: {
      candidates: [{ id: 'c_LEGACYcand01', name: 'Ana', votes: 1, pctValid: 100, pctCast: 50 }],
      castVotes: 2,
      validVotes: 1,
      abstentions: 1,
      abstentionPctCast: 50,
      expectedParticipants: 3,
      credentialsActive: 2,
      notVotedCredentials: 0,
      missingVsExpected: 1,
      turnoutPctExpected: 66.67,
      maxVotes: 1,
      leaders: ['c_LEGACYcand01'],
      tie: false,
      singleCandidate: true,
    },
    resultHash: null,
  };
  const participant = (n) => ({
    id: `p_LEGACYpart0${n}`,
    label: `Credencial 00${n}`,
    tokenHash: String(n).repeat(64),
    codeHash: String(n + 2).repeat(64),
    createdAt: t,
    firstSeenAt: t,
    reissuedAt: null,
    revoked: false,
    revokedAt: null,
  });
  const m = {
    schemaVersion: 1,
    id: 'm_LEGACYabcdef',
    name: 'Reunião antiga',
    status: 'active',
    expectedParticipants: 3,
    createdAt: t,
    updatedAt: t,
    archivedAt: null,
    version: 7,
    currentOfficeId: office.id,
    participantSeq: 2,
    participants: [participant(1), participant(2)],
    offices: [office],
  };
  office.resultHash = D.resultHash(m.id, office);
  return m;
}

test('reuniões antigas (com credenciais) são migradas preservando votos e resultados selados', async () => {
  const dataDir = tmpDir();
  const legacy = legacyMeeting();
  fs.mkdirSync(path.join(dataDir, 'meetings'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'meetings', `${legacy.id}.json`), JSON.stringify(legacy));

  const srv = await startServer({ dataDir, log: quietLog });
  await srv.client.login();
  const snap = (await srv.client.admin('GET', legacy.id, '')).body;
  assert.equal(snap.schemaVersion, 2);
  assert.equal(snap.offices[0].result.castVotes, 2);
  assert.equal(snap.offices[0].resultHash, legacy.offices[0].resultHash, 'selo SHA-256 continua válido');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'meetings', `${legacy.id}.json`), 'utf8'));
  assert.equal(onDisk.schemaVersion, 2);
  assert.equal('participants' in onDisk, false);
  assert.equal('voterIds' in onDisk.offices[0], false);
  const backups = fs.readdirSync(path.join(dataDir, 'backups', legacy.id));
  assert.ok(backups.some((f) => f.includes('pre-migracao-v1')), 'original guardado antes de migrar');

  // A reunião migrada continua funcionando no fluxo público.
  const o = await srv.client.admin('POST', legacy.id, '/offices', { title: 'Vice' });
  await srv.client.admin('POST', legacy.id, `/offices/${o.body.officeId}/candidates`, { name: 'Bia' });
  await srv.client.admin('POST', legacy.id, `/offices/${o.body.officeId}/open`);
  const cand = (await srv.client.admin('GET', legacy.id, '')).body.offices[1].candidates[0].id;
  assert.equal((await srv.client.vote(legacy.id, o.body.officeId, cand)).status, 201);
  await srv.app.close();

  // Exportação v1 também pode ser importada.
  const b = await startServer();
  await b.client.login();
  const imp = await b.client.req('POST', '/api/admin/import', { format: 'nomeia-export', schemaVersion: 1, meeting: legacyMeeting(), ledger: [] });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  await b.app.close();
});
