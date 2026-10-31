'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setupMeeting, newOffice } = require('./helpers');

let srv;
let c;

test.before(async () => {
  srv = await startServer();
  c = srv.client;
  await c.login();
});

test.after(() => srv.app.close());

test('votação não está disponível enquanto o cargo está em discussão', async () => {
  const s = await setupMeeting(c);
  const pub = await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.phase, 'discussing');
  assert.equal(pub.body.currentOffice.candidates.length, 2);

  const r = await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'voting_not_open');

  const snap = (await c.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].turnout.voted, 0);
});

test('dois votos simultâneos da mesma credencial resultam em um único registro', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const attempts = await Promise.all(
    Array.from({ length: 25 }, (_, i) => c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[i % 2].id)),
  );
  const ok = attempts.filter((r) => r.status === 201);
  const dup = attempts.filter((r) => r.status === 409 && r.body.error.code === 'already_voted');
  assert.equal(ok.length, 1);
  assert.equal(dup.length, 24);

  // Mesmo usando token e código (mesma credencial) em paralelo.
  const mixed = await Promise.all([
    c.vote(s.meetingId, s.tokens[1], s.officeId, s.cands[0].id),
    c.vote(s.meetingId, s.codes[1], s.officeId, s.cands[1].id),
    c.vote(s.meetingId, s.codes[1].replace(/-/g, '').toLowerCase(), s.officeId, 'abstain'),
  ]);
  assert.equal(mixed.filter((r) => r.status === 201).length, 1);

  const live = (await c.admin('GET', s.meetingId, '')).body.offices[0].live;
  assert.equal(live.castVotes, 2);
});

test('recarregar/reabrir a página não permite novo voto', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  assert.equal((await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id)).status, 201);

  // "Reabrir a página": o cliente consulta o servidor e descobre que já votou.
  const me = await c.req('POST', '/api/credentials/check', undefined, { bearer: s.tokens[0], cookie: null });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.votedOfficeIds, [s.officeId]);

  const again = await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[1].id);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_voted');
});

test('credencial vota no cargo A e pode votar normalmente no cargo B', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  assert.equal((await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id)).status, 201);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);

  // Nomes podem se repetir entre cargos sem misturar votos.
  const b = await newOffice(c, s.meetingId, 'Secretário', ['Ana', 'Carla']);
  await c.admin('POST', s.meetingId, `/offices/${b.officeId}/open`);

  // Voto no cargo A (encerrado) é recusado; candidato de A não vale em B.
  assert.equal((await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id)).body.error.code, 'voting_closed');
  assert.equal((await c.vote(s.meetingId, s.tokens[0], b.officeId, s.cands[0].id)).body.error.code, 'invalid_choice');

  assert.equal((await c.vote(s.meetingId, s.tokens[0], b.officeId, b.cands[0].id)).status, 201);
  const snap = (await c.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].result.castVotes, 1);
  assert.equal(snap.offices[1].live.castVotes, 1);
  assert.deepEqual(snap.participants[0].votedOfficeIds.sort(), [s.officeId, b.officeId].sort());
});

test('sem credencial, o link público mostra a reunião mas não aceita votos', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const pub = await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.currentOffice.status, 'voting_open');
  assert.equal(pub.body.currentOffice.candidates.length, 2);

  const none = await c.req('POST', `/api/meetings/${s.meetingId}/votes`, { officeId: s.officeId, choice: s.cands[0].id }, { cookie: null });
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'credential_required');

  const fake = await c.vote(s.meetingId, 'x'.repeat(43), s.officeId, s.cands[0].id);
  assert.equal(fake.status, 403);
  assert.equal(fake.body.error.code, 'invalid_credential');

  // Credencial de outra reunião não vale aqui.
  const other = await setupMeeting(c);
  const cross = await c.vote(s.meetingId, other.tokens[0], s.officeId, s.cands[0].id);
  assert.equal(cross.status, 403);

  // O cliente não pode impor contadores: campos extras são ignorados.
  const forged = await c.req(
    'POST',
    `/api/meetings/${s.meetingId}/votes`,
    { officeId: s.officeId, choice: s.cands[0].id, votes: 1000, count: 99 },
    { bearer: s.tokens[0], cookie: null },
  );
  assert.equal(forged.status, 201);
  const live = (await c.admin('GET', s.meetingId, '')).body.offices[0].live;
  assert.equal(live.castVotes, 1);
  assert.equal(live.candidates[0].votes, 1);
});

test('voto no último instante do encerramento: o servidor decide pela ordem de processamento', async () => {
  for (let round = 0; round < 5; round++) {
    const s = await setupMeeting(c, { creds: 20 });
    await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
    const votes = s.tokens.map((t, i) => c.vote(s.meetingId, t, s.officeId, s.cands[i % 2].id));
    const closeAt = round * 4; // o encerramento entra em pontos diferentes da fila
    votes.splice(closeAt, 0, c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`));
    const results = await Promise.all(votes);
    const closeRes = results.splice(closeAt, 1)[0];
    assert.equal(closeRes.status, 200);

    const accepted = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(accepted + rejected.length, 20);
    for (const r of rejected) assert.equal(r.body.error.code, 'voting_closed');

    const office = (await c.admin('GET', s.meetingId, '')).body.offices[0];
    assert.equal(office.result.castVotes, accepted, 'resultado contém exatamente os votos aceitos');
    // Depois do encerramento, nenhum voto entra.
    const late = await c.vote(s.meetingId, s.tokens[19], s.officeId, s.cands[0].id);
    assert.equal(late.status, 409);
  }
});

test('contagens e percentuais corretos, com empate e candidato com zero votos', async () => {
  const s = await setupMeeting(c, { expected: 8, candidates: ['Ana', 'Bruno', 'Carla'], creds: 6 });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const [ana, bruno] = s.cands;
  const plan = [ana.id, ana.id, bruno.id, bruno.id, 'abstain'];
  for (const [i, choice] of plan.entries()) assert.equal((await c.vote(s.meetingId, s.tokens[i], s.officeId, choice)).status, 201);
  // 6ª credencial não vota.

  const closed = await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const r = closed.body.offices[0].result;
  assert.equal(r.castVotes, 5);
  assert.equal(r.validVotes, 4);
  assert.equal(r.abstentions, 1);
  assert.equal(r.abstentionPctCast, 20);
  assert.equal(r.notVotedCredentials, 1);
  assert.equal(r.missingVsExpected, 3);
  assert.equal(r.expectedParticipants, 8);
  assert.equal(r.turnoutPctExpected, 62.5);
  const by = Object.fromEntries(r.candidates.map((x) => [x.name, x]));
  assert.deepEqual([by.Ana.votes, by.Ana.pctValid, by.Ana.pctCast], [2, 50, 40]);
  assert.deepEqual([by.Bruno.votes, by.Bruno.pctValid, by.Bruno.pctCast], [2, 50, 40]);
  assert.deepEqual([by.Carla.votes, by.Carla.pctValid, by.Carla.pctCast], [0, 0, 0], 'candidato com zero votos aparece');
  assert.equal(r.tie, true);
  assert.deepEqual(r.leaders.sort(), [ana.id, bruno.id].sort());

  // Percentual com dízima é arredondado a 2 casas.
  const s2 = await setupMeeting(c, { candidates: ['X', 'Y'], creds: 3 });
  await c.admin('POST', s2.meetingId, `/offices/${s2.officeId}/open`);
  for (let i = 0; i < 3; i++) await c.vote(s2.meetingId, s2.tokens[i], s2.officeId, s2.cands[i === 2 ? 1 : 0].id);
  const r2 = (await c.admin('POST', s2.meetingId, `/offices/${s2.officeId}/close`)).body.offices[0].result;
  assert.equal(r2.candidates[0].pctValid, 66.67);
  assert.equal(r2.candidates[1].pctValid, 33.33);
  assert.equal(r2.tie, false);

  // Nenhum voto: todos zero, sem vencedor nem divisão por zero.
  const s3 = await setupMeeting(c, { candidates: ['Único'], creds: 2 });
  await c.admin('POST', s3.meetingId, `/offices/${s3.officeId}/open`);
  const r3 = (await c.admin('POST', s3.meetingId, `/offices/${s3.officeId}/close`)).body.offices[0].result;
  assert.equal(r3.castVotes, 0);
  assert.deepEqual(r3.leaders, []);
  assert.equal(r3.candidates[0].pctValid, 0);
  assert.equal(r3.singleCandidate, true);
});

test('candidato único: opções candidato ou abstenção, sem aprovação automática', async () => {
  const s = await setupMeeting(c, { candidates: ['Única'], creds: 3 });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.tokens[0], s.officeId, 'abstain');
  await c.vote(s.meetingId, s.tokens[1], s.officeId, 'abstain');
  await c.vote(s.meetingId, s.tokens[2], s.officeId, s.cands[0].id);
  const r = (await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`)).body.offices[0].result;
  assert.equal(r.singleCandidate, true);
  assert.equal(r.abstentions, 2);
  assert.equal(r.candidates[0].votes, 1);
  assert.equal(r.candidates[0].pctValid, 100);
  assert.equal(r.candidates[0].pctCast, 33.33);
  assert.equal('elected' in r || 'approved' in r, false);
});

test('histórico distingue abstenção de quem não votou (inclusive no CSV)', async () => {
  const s = await setupMeeting(c, { expected: 5, creds: 3 });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await c.vote(s.meetingId, s.tokens[1], s.officeId, 'abstain');
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/publish`);

  const pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  const h = pub.history[0].results;
  assert.equal(h.castVotes, 2);
  assert.equal(h.abstentions, 1);
  assert.equal(h.validVotes, 1);
  assert.equal(h.notVotedCredentials, 1);
  assert.equal(h.missingVsExpected, 3);

  const csv = (await c.admin('GET', s.meetingId, `/offices/${s.officeId}/export.csv`)).body;
  assert.match(csv, /abstencao;;Abstenção;1;/);
  assert.match(csv, /Credenciais ativas que NÃO votaram;1;/);
  assert.match(csv, /Previstos sem voto registrado;3;/);
});

test('resultados fechados não podem ser editados', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  const closed = await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  const before = closed.body.offices[0];

  const attempts = [
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/candidates`, { name: 'Novo' }),
    c.admin('PATCH', s.meetingId, `/offices/${s.officeId}/candidates/${s.cands[0].id}`, { name: 'Outro' }),
    c.admin('DELETE', s.meetingId, `/offices/${s.officeId}/candidates/${s.cands[1].id}`),
    c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { title: 'Renomeado' }),
    c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'live' }),
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`),
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`),
    c.admin('POST', s.meetingId, `/offices/${s.officeId}/start`),
    c.vote(s.meetingId, s.tokens[1], s.officeId, s.cands[1].id),
  ];
  for (const r of await Promise.all(attempts)) assert.equal(r.status, 409, JSON.stringify(r.body));

  const after = (await c.admin('GET', s.meetingId, '')).body.offices[0];
  assert.deepEqual(after.result, before.result);
  assert.equal(after.resultHash, before.resultHash);
  assert.equal(after.title, before.title);

  // Reunião encerrada é somente leitura.
  await c.admin('POST', s.meetingId, '/archive');
  const ro = await c.admin('POST', s.meetingId, '/offices', { title: 'Depois' });
  assert.equal(ro.status, 409);
  assert.equal(ro.body.error.code, 'meeting_archived');
  assert.equal((await c.admin('POST', s.meetingId, '/credentials', { count: 1 })).status, 409);
  assert.equal((await c.admin('GET', s.meetingId, '/export.csv')).status, 200, 'leitura histórica continua disponível');
});

test('não é possível abrir a votação de um segundo cargo com outro em andamento', async () => {
  const s = await setupMeeting(c);
  const r = await c.admin('POST', s.meetingId, '/offices', { title: 'Tesoureiro' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'office_in_progress');
  // Mas é possível preparar um cargo como rascunho.
  const draft = await c.admin('POST', s.meetingId, '/offices', { title: 'Tesoureiro', start: false });
  assert.equal(draft.status, 201);
  const pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.title, 'Presidente', 'rascunho não aparece para o público');
});

test('resultados ocultos até publicação; modo ao vivo mostra parcial', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  let pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results, null);
  assert.equal(pub.currentOffice.turnout.voted, 1, 'contador de participação é público');

  await c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'live' });
  pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results.candidates[0].votes, 1);

  await c.admin('PATCH', s.meetingId, `/offices/${s.officeId}`, { resultsMode: 'on_publish' });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);
  pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results, null);
  assert.equal(pub.history[0].results, null);

  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/publish`);
  pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.results.castVotes, 1);
});

test('reemissão recupera credencial sem gerar voto extra; revogação bloqueia', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  assert.equal((await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id)).status, 201);
  const pid = (await c.admin('GET', s.meetingId, '')).body.participants[0].id;
  const re = await c.admin('POST', s.meetingId, `/participants/${pid}/reissue`);
  assert.equal(re.status, 200);
  const newToken = re.body.issued[0].link.split('#t=')[1];

  assert.equal((await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[1].id)).status, 403, 'token antigo invalidado');
  const again = await c.vote(s.meetingId, newToken, s.officeId, s.cands[1].id);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_voted', 'novo cartão herda o voto já registrado');

  const pid2 = (await c.admin('GET', s.meetingId, '')).body.participants[1].id;
  await c.admin('POST', s.meetingId, `/participants/${pid2}/revoke`);
  const rv = await c.vote(s.meetingId, s.tokens[1], s.officeId, s.cands[0].id);
  assert.equal(rv.status, 403);
  assert.equal(rv.body.error.code, 'credential_revoked');
});
