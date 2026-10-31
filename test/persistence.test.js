'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, setupMeeting, newOffice, tmpDir } = require('./helpers');
const { Store } = require('../src/store');

test('votos e histórico persistem após reiniciar o servidor', async () => {
  const dataDir = tmpDir();
  let srv = await startServer({ dataDir });
  await srv.client.login();
  const s = await setupMeeting(srv.client, { creds: 3 });
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await srv.client.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await srv.client.vote(s.meetingId, s.tokens[1], s.officeId, 'abstain');
  await srv.app.close();

  // Reinício: mesma pasta de dados, novo processo de aplicação.
  srv = await startServer({ dataDir });
  await srv.client.login();
  const snap = (await srv.client.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].status, 'voting_open');
  assert.equal(snap.offices[0].live.castVotes, 2);
  assert.equal(snap.offices[0].live.abstentions, 1);

  // Credenciais continuam válidas e o voto já registrado continua bloqueando repetição.
  assert.equal((await srv.client.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[1].id)).body.error.code, 'already_voted');
  assert.equal((await srv.client.vote(s.meetingId, s.codes[2], s.officeId, s.cands[1].id)).status, 201);

  const closed = await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const hash = closed.body.offices[0].resultHash;
  await srv.app.close();

  srv = await startServer({ dataDir });
  await srv.client.login();
  const after = (await srv.client.admin('GET', s.meetingId, '')).body.offices[0];
  assert.equal(after.status, 'closed');
  assert.equal(after.resultHash, hash);
  assert.equal(after.result.castVotes, 3);

  const ledger = await srv.app.store.readLedger(s.meetingId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, 'office_closed');
  assert.equal(Store.verifyLedger(ledger), true);
  await srv.app.close();
});

test('arquivo corrompido é recuperado do backup mais recente; temporários são descartados', async () => {
  const dataDir = tmpDir();
  let srv = await startServer({ dataDir });
  await srv.client.login();
  const s = await setupMeeting(srv.client, { creds: 2 });
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await srv.client.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`); // gera backup
  await srv.app.close();

  const file = path.join(dataDir, 'meetings', `${s.meetingId}.json`);
  fs.writeFileSync(file, '{ "corrompido": ');
  const tmp = path.join(dataDir, 'meetings', `.${s.meetingId}.json.abc123.tmp`);
  fs.writeFileSync(tmp, 'parcial');

  srv = await startServer({ dataDir, log: { info() {}, warn() {}, error() {} } });
  await srv.client.login();
  const snap = (await srv.client.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].status, 'closed');
  assert.equal(snap.offices[0].result.castVotes, 1);
  assert.equal(fs.existsSync(tmp), false);
  JSON.parse(fs.readFileSync(file, 'utf8')); // arquivo principal reescrito válido
  await srv.app.close();
});

test('exportar e reimportar preserva IDs e histórico; importação nunca sobrescreve', async () => {
  const a = await startServer();
  await a.client.login();
  const s = await setupMeeting(a.client, { creds: 3 });
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await a.client.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await a.client.vote(s.meetingId, s.tokens[1], s.officeId, 'abstain');
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const b2 = await newOffice(a.client, s.meetingId, 'Tesoureiro', ['Ana', 'Davi']);
  await a.client.admin('POST', s.meetingId, `/offices/${b2.officeId}/open`);
  await a.client.vote(s.meetingId, s.tokens[0], b2.officeId, b2.cands[1].id);
  await a.client.admin('POST', s.meetingId, `/offices/${b2.officeId}/close`);
  await a.client.admin('POST', s.meetingId, `/offices/${b2.officeId}/publish`);

  const exp = await a.client.admin('GET', s.meetingId, '/export.json');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  const doc = exp.body;
  assert.equal(doc.format, 'nomeia-export');
  assert.equal(JSON.stringify(doc).includes(s.tokens[0]), false, 'exportação não contém tokens em claro');

  // Reimportar no mesmo servidor é recusado (não sobrescreve resultados).
  const dup = await a.client.req('POST', '/api/admin/import', doc);
  assert.equal(dup.status, 409);
  const original = (await a.client.admin('GET', s.meetingId, '')).body;
  await a.app.close();

  // Importar em outro servidor (pasta vazia) preserva IDs, resultados, ledger e credenciais.
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
  assert.deepEqual(
    copy.participants.map((p) => p.id),
    original.participants.map((p) => p.id),
  );
  assert.equal((await b.app.store.readLedger(s.meetingId)).length, doc.ledger.length);
  const me = await b.client.req('POST', '/api/credentials/check', undefined, { bearer: s.tokens[0], cookie: null });
  assert.deepEqual(me.body.votedOfficeIds.sort(), [s.officeId, b2.officeId].sort());

  // Re-exportar dá o mesmo conteúdo de reunião.
  const again = (await b.client.admin('GET', s.meetingId, '/export.json')).body;
  assert.deepEqual(again.meeting, doc.meeting);
  await b.app.close();
});

test('importação rejeita arquivos adulterados ou inválidos', async () => {
  const a = await startServer();
  await a.client.login();
  const s = await setupMeeting(a.client, { creds: 2 });
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await a.client.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await a.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const doc = (await a.client.admin('GET', s.meetingId, '/export.json')).body;
  await a.app.close();

  const b = await startServer();
  await b.client.login();
  const tamper = structuredClone(doc);
  tamper.meeting.offices[0].result.candidates[1].votes = 50;
  let r = await b.client.req('POST', '/api/admin/import', tamper);
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
  const s = await setupMeeting(srv.client, { creds: 1 });
  for (let i = 0; i < 8; i++) {
    const r = await srv.client.admin('POST', s.meetingId, '/backup');
    assert.equal(r.status, 201);
  }
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await srv.client.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await srv.client.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const list = (await srv.client.admin('GET', s.meetingId, '/backups')).body.backups;
  assert.equal(list.length, 5);
  assert.match(list[list.length - 1], /office-closed/);
  const newest = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'backups', s.meetingId, list[list.length - 1]), 'utf8'));
  assert.equal(newest.meeting.offices[0].result.castVotes, 1, 'último backup contém a última votação');
  await srv.app.close();
});
