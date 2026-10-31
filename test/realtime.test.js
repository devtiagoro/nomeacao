'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setupMeeting, wsClient } = require('./helpers');

let srv;
let c;

test.before(async () => {
  srv = await startServer();
  c = srv.client;
  await c.login();
});

test.after(() => srv.app.close());

test('admin cria cargo e adiciona nomes; dois celulares recebem a atualização', async () => {
  const m = await c.req('POST', '/api/admin/meetings', { name: 'Tempo real', expectedParticipants: 5 });
  const meetingId = m.body.id;
  const phone1 = wsClient(srv.base, meetingId);
  const phone2 = wsClient(srv.base, meetingId);
  const presenter = wsClient(srv.base, meetingId);
  await Promise.all([phone1.opened, phone2.opened, presenter.opened]);
  for (const p of [phone1, phone2]) {
    const snap = await p.waitFor((x) => x.type === 'snapshot');
    assert.equal(snap.state.currentOffice, null);
  }

  const o = await c.admin('POST', meetingId, '/offices', { title: 'Coordenador' });
  for (const p of [phone1, phone2, presenter]) {
    const ev = await p.waitFor((x) => x.type === 'office_updated');
    assert.equal(ev.state.currentOffice.title, 'Coordenador');
    assert.equal(ev.state.currentOffice.status, 'discussing');
  }

  await c.admin('POST', meetingId, `/offices/${o.body.officeId}/candidates`, { name: 'Maria' });
  await c.admin('POST', meetingId, `/offices/${o.body.officeId}/candidates`, { name: 'João' });
  for (const p of [phone1, phone2]) {
    const ev = await p.waitFor((x) => x.type === 'candidates_updated' && x.state.currentOffice.candidates.length === 2);
    assert.deepEqual(
      ev.state.currentOffice.candidates.map((x) => x.name),
      ['Maria', 'João'],
    );
  }

  // Edição e remoção também chegam.
  const cid = (await c.admin('GET', meetingId, '')).body.offices[0].candidates[1].id;
  await c.admin('PATCH', meetingId, `/offices/${o.body.officeId}/candidates/${cid}`, { name: 'João Silva' });
  await phone1.waitFor((x) => x.state.currentOffice?.candidates.some((k) => k.name === 'João Silva'));
  await c.admin('DELETE', meetingId, `/offices/${o.body.officeId}/candidates/${cid}`);
  await phone2.waitFor((x) => x.type === 'candidates_updated' && x.state.currentOffice.candidates.length === 1);

  // Abrir votação chega imediatamente a todos.
  await c.admin('POST', meetingId, `/offices/${o.body.officeId}/open`);
  for (const p of [phone1, phone2, presenter]) {
    const ev = await p.waitFor((x) => x.type === 'vote_opened');
    assert.equal(ev.state.currentOffice.status, 'voting_open');
  }

  // Versões são monotônicas: o cliente descarta mensagens antigas/duplicadas.
  const versions = phone1.messages.map((x) => x.version);
  assert.deepEqual([...versions].sort((a, b) => a - b), versions);
  for (const p of [phone1, phone2, presenter]) p.close();
});

test('eventos de votação: vote_accepted, turnout, vote_closed, results_published, next_office, meeting_closed', async () => {
  const s = await setupMeeting(c, { creds: 2 });
  const phone = wsClient(srv.base, s.meetingId);
  const admin = wsClient(srv.base, s.meetingId, { role: 'admin', cookie: c.cookie });
  await Promise.all([phone.opened, admin.opened]);

  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.tokens[0], s.officeId, 'abstain');
  const acc = await phone.waitFor((x) => x.type === 'vote_accepted');
  assert.equal(acc.state.currentOffice.turnout.voted, 1);
  assert.equal(acc.state.currentOffice.results, null, 'público não vê apuração antes da publicação');
  assert.equal(JSON.stringify(acc.state).includes(s.tokens[0]), false);

  const adm = await admin.waitFor((x) => x.type === 'vote_accepted');
  assert.equal(adm.state.offices[0].live.abstentions, 1, 'mesa vê abstenções e válidos');
  assert.equal(adm.state.offices[0].live.notVotedCredentials, 1);
  assert.equal(JSON.stringify(adm.state).includes('tokenHash'), false);

  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  await phone.waitFor((x) => x.type === 'vote_closed');
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/publish`);
  const pub = await phone.waitFor((x) => x.type === 'results_published');
  assert.equal(pub.state.currentOffice.results.abstentions, 1);

  await c.admin('POST', s.meetingId, '/offices', { title: 'Vice' });
  const next = await phone.waitFor((x) => x.type === 'next_office');
  assert.equal(next.state.currentOffice.title, 'Vice');
  assert.equal(next.state.history.length, 1, 'cargo anterior permanece no histórico');

  await c.admin('POST', s.meetingId, '/credentials', { count: 1 });
  await admin.waitFor((x) => x.type === 'turnout_updated');

  await c.admin('POST', s.meetingId, '/archive');
  const closed = await phone.waitFor((x) => x.type === 'meeting_closed');
  assert.equal(closed.state.status, 'archived');
  phone.close();
  admin.close();
});

test('PWA sincroniza ao reabrir: nova conexão recebe snapshot com o estado mais recente', async () => {
  const s = await setupMeeting(c, { creds: 1 });
  const first = wsClient(srv.base, s.meetingId);
  const snap1 = await first.waitFor((x) => x.type === 'snapshot');
  first.close(); // app fechado / em segundo plano

  // Mudanças acontecem enquanto o app está fechado.
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/candidates`, { name: 'Carla' });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);

  const reopened = wsClient(srv.base, s.meetingId);
  const snap2 = await reopened.waitFor((x) => x.type === 'snapshot');
  assert.ok(snap2.version > snap1.version);
  assert.equal(snap2.state.currentOffice.status, 'voting_open');
  assert.equal(snap2.state.currentOffice.candidates.length, 3);

  // Pedido explícito de sincronização (ao voltar para o primeiro plano).
  reopened.ws.send(JSON.stringify({ type: 'sync' }));
  await reopened.waitFor((x, i) => x.type === 'snapshot' && reopened.messages.filter((m) => m.type === 'snapshot').length >= 2);

  // Heartbeat de aplicação.
  reopened.ws.send(JSON.stringify({ type: 'ping' }));
  await reopened.waitFor((x) => x.type === 'pong');
  reopened.close();
});

test('canal administrativo exige sessão; reunião inexistente é recusada', async () => {
  const s = await setupMeeting(c, { creds: 0 });
  const intruder = wsClient(srv.base, s.meetingId, { role: 'admin' });
  const info = await intruder.closed();
  assert.equal(info.code, 4401);
  assert.equal(intruder.messages.length, 0, 'nenhum dado administrativo enviado');

  const ghost = wsClient(srv.base, 'm_AAAAAAAAAAAA');
  assert.equal((await ghost.closed()).code, 4404);
});

test('WebSocket recusa origem não permitida', async () => {
  const s = await setupMeeting(c, { creds: 0 });
  const WebSocket = require('ws');
  const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/ws?meeting=${s.meetingId}`, { headers: { Origin: 'https://evil.example' } });
  ws.on('error', () => {});
  const status = await new Promise((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode)));
  assert.equal(status, 403);
  ws.terminate();
});
