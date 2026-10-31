'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setupMeeting, wsClient } = require('./helpers');

const PAGES = 'https://devtiagoro.github.io';
let srv;
let c;

test.before(async () => {
  srv = await startServer({ publicAppUrl: `${PAGES}/nomeacao/public/` });
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
  for (const p of [phone1, phone2]) assert.equal((await p.waitFor((x) => x.type === 'snapshot')).state.currentOffice, null);

  const o = await c.admin('POST', meetingId, '/offices', { title: 'Coordenador' });
  for (const p of [phone1, phone2, presenter]) {
    const ev = await p.waitFor((x) => x.type === 'office_updated');
    assert.equal(ev.state.currentOffice.title, 'Coordenador');
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

  await c.admin('POST', meetingId, `/offices/${o.body.officeId}/open`);
  for (const p of [phone1, phone2, presenter]) {
    assert.equal((await p.waitFor((x) => x.type === 'vote_opened')).state.currentOffice.status, 'voting_open');
  }
  const versions = phone1.messages.map((x) => x.version);
  assert.deepEqual([...versions].sort((a, b) => a - b), versions, 'versões monotônicas');
  for (const p of [phone1, phone2, presenter]) p.close();
});

test('resultados e contadores atualizam em tempo real a cada voto', async () => {
  const s = await setupMeeting(c, { expected: 2 });
  const phone = wsClient(srv.base, s.meetingId);
  const admin = wsClient(srv.base, s.meetingId, { role: 'admin', cookie: c.cookie });
  await Promise.all([phone.opened, admin.opened]);
  await c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'live' });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);

  // Três votos do mesmo "aparelho" (mais votos do que presentes é permitido).
  for (let i = 1; i <= 3; i++) {
    await c.vote(s.meetingId, s.officeId, s.cands[0].id);
    const ev = await phone.waitFor((x) => x.type === 'vote_accepted' && x.state.currentOffice.turnout.votes === i);
    assert.equal(ev.state.currentOffice.results.candidates[0].votes, i, 'apuração ao vivo atualizada');
    assert.equal(ev.state.currentOffice.turnout.present, 2);
  }
  const adm = await admin.waitFor((x) => x.type === 'vote_accepted' && x.state.offices[0].live.castVotes === 3);
  assert.equal(adm.state.offices[0].live.validVotes, 3);
  assert.equal(JSON.stringify(adm.state).includes('participants'), false);

  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  await phone.waitFor((x) => x.type === 'vote_closed');
  phone.close();
  admin.close();
});

test('próximo cargo chega automaticamente aos celulares, sem reler QR Code', async () => {
  const s = await setupMeeting(c);
  const phone = wsClient(srv.base, s.meetingId);
  await phone.opened;
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.officeId, s.cands[1].id);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/publish`);
  await phone.waitFor((x) => x.type === 'results_published');

  await c.admin('POST', s.meetingId, '/offices', { title: 'Vice' });
  const next = await phone.waitFor((x) => x.type === 'next_office');
  assert.equal(next.state.currentOffice.title, 'Vice');
  assert.equal(next.state.currentOffice.status, 'discussing');
  assert.equal(next.state.history.length, 1, 'cargo anterior permanece no histórico');

  await c.admin('POST', s.meetingId, `/offices/${next.state.currentOffice.id}/candidates`, { name: 'Davi' });
  await phone.waitFor((x) => x.type === 'candidates_updated' && x.state.currentOffice.candidates.some((k) => k.name === 'Davi'));
  await c.admin('POST', s.meetingId, `/offices/${next.state.currentOffice.id}/open`);
  await phone.waitFor((x) => x.type === 'vote_opened' && x.state.currentOffice.title === 'Vice');

  await c.admin('POST', s.meetingId, `/offices/${next.state.currentOffice.id}/close`);
  await c.admin('POST', s.meetingId, '/archive');
  assert.equal((await phone.waitFor((x) => x.type === 'meeting_closed')).state.status, 'archived');
  phone.close();
});

test('PWA sincroniza ao reabrir: nova conexão recebe o estado mais recente', async () => {
  const s = await setupMeeting(c);
  const first = wsClient(srv.base, s.meetingId);
  const snap1 = await first.waitFor((x) => x.type === 'snapshot');
  first.close();
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/candidates`, { name: 'Carla' });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);

  const reopened = wsClient(srv.base, s.meetingId);
  const snap2 = await reopened.waitFor((x) => x.type === 'snapshot');
  assert.ok(snap2.version > snap1.version);
  assert.equal(snap2.state.currentOffice.status, 'voting_open');
  assert.equal(snap2.state.currentOffice.candidates.length, 3);
  reopened.ws.send(JSON.stringify({ type: 'ping' }));
  await reopened.waitFor((x) => x.type === 'pong');
  reopened.close();
});

test('canal administrativo exige sessão; reunião inexistente é recusada', async () => {
  const s = await setupMeeting(c);
  const intruder = wsClient(srv.base, s.meetingId, { role: 'admin' });
  assert.equal((await intruder.closed()).code, 4401);
  assert.equal(intruder.messages.length, 0, 'nenhum dado administrativo enviado');
  const ghost = wsClient(srv.base, 'm_AAAAAAAAAAAA');
  assert.equal((await ghost.closed()).code, 4404);
});

test('WebSocket: aceita a origem publicada (GitHub Pages) e recusa origens desconhecidas', async () => {
  const s = await setupMeeting(c);
  const pages = wsClient(srv.base, s.meetingId, { origin: PAGES });
  await pages.opened;
  assert.equal((await pages.waitFor((x) => x.type === 'snapshot')).state.id, s.meetingId);
  pages.close();
  const evil = wsClient(srv.base, s.meetingId, { origin: 'https://evil.example' });
  await assert.rejects(evil.opened, /HTTP 403/);
});
