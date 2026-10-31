'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setupMeeting, newOffice, rid } = require('./helpers');

let srv;
let c;

test.before(async () => {
  srv = await startServer();
  c = srv.client;
  await c.login();
});

test.after(() => srv.app.close());

const adminOffice = async (meetingId, i = 0) => (await c.admin('GET', meetingId, '')).body.offices[i];

test('votação não está disponível enquanto o cargo está em discussão', async () => {
  const s = await setupMeeting(c);
  const pub = await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.phase, 'discussing');
  assert.equal(pub.body.currentOffice.candidates.length, 2);

  const r = await c.vote(s.meetingId, s.officeId, s.cands[0].id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'voting_not_open');
  assert.equal((await adminOffice(s.meetingId)).turnout.votes, 0);
});

test('voto público sem credencial, login ou identificação', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  // Requisição "crua", como um navegador anônimo: sem cookie, sem Authorization.
  const r = await fetch(`${srv.base}/api/meetings/${s.meetingId}/votes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nomeia': '1' },
    body: JSON.stringify({ officeId: s.officeId, choice: s.cands[0].id, requestId: rid() }),
  });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).status, 'accepted');
  const live = (await adminOffice(s.meetingId)).live;
  assert.equal(live.castVotes, 1);
  assert.equal(live.candidates[0].votes, 1);
  // As rotas de credencial não existem mais.
  assert.equal((await c.req('POST', '/api/credentials/check', undefined, { cookie: null })).status, 404);
});

test('o mesmo dispositivo pode votar várias vezes de propósito, inclusive no mesmo cargo', async () => {
  const s = await setupMeeting(c, { expected: 3 });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  // Mesmo "aparelho" (mesmo cliente/IP), confirmações sucessivas com a mesma escolha.
  for (let i = 0; i < 4; i++) {
    const r = await c.vote(s.meetingId, s.officeId, s.cands[0].id);
    assert.equal(r.status, 201, `voto ${i + 1}`);
  }
  // E confirmações simultâneas distintas também contam todas.
  const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) => c.vote(s.meetingId, s.officeId, i % 2 ? 'abstain' : s.cands[1].id)));
  assert.ok(parallel.every((r) => r.status === 201));
  const live = (await adminOffice(s.meetingId)).live;
  assert.equal(live.castVotes, 10);
  assert.equal(live.candidates.find((x) => x.name === 'Ana').votes, 4);
  assert.equal(live.candidates.find((x) => x.name === 'Bruno').votes, 3);
  assert.equal(live.abstentions, 3);
  // Votos e pessoas presentes são independentes: 10 votos com 3 presentes é permitido.
  assert.equal(live.presentParticipants, 3);
});

test('reenvio acidental da mesma confirmação (duplo clique/retransmissão) conta uma vez', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const id = rid();
  const attempts = await Promise.all(Array.from({ length: 20 }, () => c.vote(s.meetingId, s.officeId, s.cands[0].id, id)));
  assert.equal(attempts.filter((r) => r.status === 201).length, 1);
  const dup = attempts.filter((r) => r.status === 200);
  assert.equal(dup.length, 19);
  for (const r of dup) assert.equal(r.body.status, 'duplicate');
  assert.equal((await adminOffice(s.meetingId)).live.castVotes, 1);

  // Retransmissão depois do encerramento: reconhecida como já registrada, não como recusa.
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const late = await c.vote(s.meetingId, s.officeId, s.cands[0].id, id);
  assert.equal(late.status, 200);
  assert.equal(late.body.status, 'duplicate');
  // Uma confirmação nova depois do encerramento é recusada.
  assert.equal((await c.vote(s.meetingId, s.officeId, s.cands[0].id)).body.error.code, 'voting_closed');
});

test('validação do voto: requestId obrigatório, opção e cargo válidos', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const base = `/api/meetings/${s.meetingId}/votes`;
  assert.equal((await c.req('POST', base, { officeId: s.officeId, choice: s.cands[0].id }, { cookie: null })).status, 400);
  assert.equal((await c.req('POST', base, { officeId: s.officeId, choice: s.cands[0].id, requestId: 'curto' }, { cookie: null })).status, 400);
  assert.equal((await c.vote(s.meetingId, s.officeId, 'c_AAAAAAAAAAAA')).body.error.code, 'invalid_choice');
  assert.equal((await c.vote(s.meetingId, 'o_AAAAAAAAAAAA', s.cands[0].id)).status, 404);
  // O cliente não impõe contadores: campos extras são ignorados.
  const forged = await c.req(
    'POST',
    base,
    { officeId: s.officeId, choice: s.cands[0].id, requestId: rid(), votes: 1000, count: 99 },
    { cookie: null },
  );
  assert.equal(forged.status, 201);
  assert.equal((await adminOffice(s.meetingId)).live.castVotes, 1);
});

test('votos nos cargos A e B são contados separadamente; nomes podem se repetir', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  assert.equal((await c.vote(s.meetingId, s.officeId, s.cands[0].id)).status, 201);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);

  const b = await newOffice(c, s.meetingId, 'Secretário', ['Ana', 'Carla']);
  await c.admin('POST', s.meetingId, `/offices/${b.officeId}/open`);
  assert.equal((await c.vote(s.meetingId, s.officeId, s.cands[0].id)).body.error.code, 'voting_closed');
  assert.equal((await c.vote(s.meetingId, b.officeId, s.cands[0].id)).body.error.code, 'invalid_choice');
  assert.equal((await c.vote(s.meetingId, b.officeId, b.cands[0].id)).status, 201);
  assert.equal((await c.vote(s.meetingId, b.officeId, b.cands[0].id)).status, 201);
  const snap = (await c.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].result.castVotes, 1);
  assert.equal(snap.offices[1].live.castVotes, 2);
});

test('voto no último instante do encerramento: o servidor decide pela ordem de processamento', async () => {
  for (let round = 0; round < 5; round++) {
    const s = await setupMeeting(c);
    await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
    const votes = Array.from({ length: 20 }, (_, i) => c.vote(s.meetingId, s.officeId, s.cands[i % 2].id));
    const closeAt = round * 4;
    votes.splice(closeAt, 0, c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`));
    const results = await Promise.all(votes);
    const closeRes = results.splice(closeAt, 1)[0];
    assert.equal(closeRes.status, 200);
    const accepted = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(accepted + rejected.length, 20);
    for (const r of rejected) assert.equal(r.body.error.code, 'voting_closed');
    assert.equal((await adminOffice(s.meetingId)).result.castVotes, accepted, 'resultado contém exatamente os votos aceitos');
  }
});

test('contagens e percentuais corretos, com empate e candidato com zero votos', async () => {
  const s = await setupMeeting(c, { expected: 8, candidates: ['Ana', 'Bruno', 'Carla'] });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const [ana, bruno] = s.cands;
  for (const choice of [ana.id, ana.id, bruno.id, bruno.id, 'abstain']) assert.equal((await c.vote(s.meetingId, s.officeId, choice)).status, 201);

  const r = (await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`)).body.offices[0].result;
  assert.equal(r.castVotes, 5);
  assert.equal(r.validVotes, 4);
  assert.equal(r.abstentions, 1);
  assert.equal(r.abstentionPctCast, 20);
  assert.equal(r.presentParticipants, 8);
  assert.equal('notVotedCredentials' in r, false);
  const by = Object.fromEntries(r.candidates.map((x) => [x.name, x]));
  assert.deepEqual([by.Ana.votes, by.Ana.pctValid, by.Ana.pctCast], [2, 50, 40]);
  assert.deepEqual([by.Bruno.votes, by.Bruno.pctValid, by.Bruno.pctCast], [2, 50, 40]);
  assert.deepEqual([by.Carla.votes, by.Carla.pctValid, by.Carla.pctCast], [0, 0, 0], 'candidato com zero votos aparece');
  assert.equal(r.tie, true);
  assert.deepEqual(r.leaders.sort(), [ana.id, bruno.id].sort());

  const s2 = await setupMeeting(c, { candidates: ['X', 'Y'] });
  await c.admin('POST', s2.meetingId, `/offices/${s2.officeId}/open`);
  for (let i = 0; i < 3; i++) await c.vote(s2.meetingId, s2.officeId, s2.cands[i === 2 ? 1 : 0].id);
  const r2 = (await c.admin('POST', s2.meetingId, `/offices/${s2.officeId}/close`)).body.offices[0].result;
  assert.equal(r2.candidates[0].pctValid, 66.67);
  assert.equal(r2.candidates[1].pctValid, 33.33);
  assert.equal(r2.tie, false);

  const s3 = await setupMeeting(c, { candidates: ['Único'] });
  await c.admin('POST', s3.meetingId, `/offices/${s3.officeId}/open`);
  const r3 = (await c.admin('POST', s3.meetingId, `/offices/${s3.officeId}/close`)).body.offices[0].result;
  assert.equal(r3.castVotes, 0);
  assert.deepEqual(r3.leaders, []);
  assert.equal(r3.candidates[0].pctValid, 0);
  assert.equal(r3.singleCandidate, true);
});

test('candidato único: opções candidato ou abstenção, sem aprovação automática', async () => {
  const s = await setupMeeting(c, { candidates: ['Única'] });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.officeId, 'abstain');
  await c.vote(s.meetingId, s.officeId, 'abstain');
  await c.vote(s.meetingId, s.officeId, s.cands[0].id);
  const r = (await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`)).body.offices[0].result;
  assert.equal(r.singleCandidate, true);
  assert.equal(r.abstentions, 2);
  assert.equal(r.candidates[0].pctValid, 100);
  assert.equal(r.candidates[0].pctCast, 33.33);
  assert.equal('elected' in r || 'approved' in r, false);
});

test('histórico e CSV distinguem abstenções, válidos e pessoas presentes', async () => {
  const s = await setupMeeting(c, { expected: 5 });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.officeId, s.cands[0].id);
  await c.vote(s.meetingId, s.officeId, 'abstain');
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/publish`);

  const h = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body.history[0].results;
  assert.deepEqual([h.castVotes, h.abstentions, h.validVotes, h.presentParticipants], [2, 1, 1, 5]);

  const csv = (await c.admin('GET', s.meetingId, `/offices/${s.officeId}/export.csv`)).body;
  assert.match(csv, /abstencao;;Abstenção;1;/);
  assert.match(csv, /Votos registrados;2;/);
  assert.match(csv, /Pessoas presentes \(informado\);5;/);
  assert.doesNotMatch(csv, /[Cc]redenci/);
});

test('resultados fechados não podem ser editados', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.officeId, s.cands[0].id);
  const before = (await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`)).body.offices[0];

  const attempts = [
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/candidates`, { name: 'Novo' }),
    c.admin('PATCH', s.meetingId, `/offices/${s.officeId}/candidates/${s.cands[0].id}`, { name: 'Outro' }),
    c.admin('DELETE', s.meetingId, `/offices/${s.officeId}/candidates/${s.cands[1].id}`),
    c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { title: 'Renomeado' }),
    c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'live' }),
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`),
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`),
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/start`),
    c.vote(s.meetingId, s.officeId, s.cands[1].id),
  ];
  for (const r of await Promise.all(attempts)) assert.equal(r.status, 409, JSON.stringify(r.body));

  const after = await adminOffice(s.meetingId);
  assert.deepEqual(after.result, before.result);
  assert.equal(after.resultHash, before.resultHash);

  await c.admin('POST', s.meetingId, '/archive');
  const ro = await c.admin('POST', s.meetingId, '/offices', { title: 'Depois' });
  assert.equal(ro.body.error.code, 'meeting_archived');
  assert.equal((await c.admin('GET', s.meetingId, '/export.csv')).status, 200, 'leitura histórica continua disponível');
});

test('não é possível iniciar um segundo cargo com outro em andamento', async () => {
  const s = await setupMeeting(c);
  const r = await c.admin('POST', s.meetingId, '/offices', { title: 'Tesoureiro' });
  assert.equal(r.body.error.code, 'office_in_progress');
  const draft = await c.admin('POST', s.meetingId, '/offices', { title: 'Tesoureiro', start: false });
  assert.equal(draft.status, 201);
  const pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.title, 'Presidente', 'rascunho não aparece para o público');
});

test('resultados ocultos até publicação; contador de votos é público; modo ao vivo mostra parcial', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.officeId, s.cands[0].id);
  let pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results, null);
  assert.equal(pub.currentOffice.turnout.votes, 1);
  assert.equal(pub.currentOffice.turnout.present, 10);

  await c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'live' });
  pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results.candidates[0].votes, 1);

  await c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'on_publish' });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results, null);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/publish`);
  pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results.castVotes, 1);
});

test('lista pública de reuniões disponíveis (para a página inicial)', async () => {
  const s = await setupMeeting(c);
  const list = await c.req('GET', '/api/meetings', undefined, { cookie: null });
  assert.equal(list.status, 200);
  const item = list.body.find((m) => m.id === s.meetingId);
  assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'name', 'phase']);
  await c.admin('POST', s.meetingId, '/archive');
  const after = (await c.req('GET', '/api/meetings', undefined, { cookie: null })).body;
  assert.equal(after.some((m) => m.id === s.meetingId), false, 'reuniões encerradas não aparecem');
});
