'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, setupMeeting, Client, SECRET } = require('./helpers');

let srv;
let c;
const logs = [];
const log = {
  info: (m) => logs.push(m),
  warn: (m) => logs.push(m),
  error: (m) => logs.push(m),
};

test.before(async () => {
  srv = await startServer({ log });
  c = srv.client;
  await c.login();
});

test.after(() => srv.app.close());

test('acesso público não consegue alterar a reunião', async () => {
  const s = await setupMeeting(c);
  const anon = new Client(srv.base);
  const pid = (await c.admin('GET', s.meetingId, '')).body.participants[0].id;
  const attempts = [
    ['GET', '/api/admin/meetings'],
    ['POST', '/api/admin/meetings', { name: 'X', expectedParticipants: 3 }],
    ['GET', `/api/admin/meetings/${s.meetingId}`],
    ['PATCH', `/api/admin/meetings/${s.meetingId}`, { name: 'Hackeada' }],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices`, { title: 'X' }],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/candidates`, { name: 'Intruso' }],
    ['DELETE', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/candidates/${s.cands[0].id}`],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/open`],
    ['POST', `/api/admin/meetings/${s.meetingId}/credentials`, { count: 50 }],
    ['POST', `/api/admin/meetings/${s.meetingId}/participants/${pid}/reissue`],
    ['POST', `/api/admin/meetings/${s.meetingId}/archive`],
    ['GET', `/api/admin/meetings/${s.meetingId}/export.json`],
    ['POST', '/api/admin/import', { format: 'nomeia-export' }],
  ];
  for (const [method, p, body] of attempts) {
    const r = await anon.req(method, p, body);
    assert.equal(r.status, 401, `${method} ${p}`);
  }
  // Credencial de participante não dá poderes administrativos.
  const asVoter = await anon.req('POST', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/open`, undefined, { bearer: s.tokens[0] });
  assert.equal(asVoter.status, 401);

  const snap = (await c.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].status, 'discussing');
  assert.equal(snap.offices[0].candidates.length, 2);
  assert.equal(snap.participants.length, 3, 'link público não emite credenciais');
});

test('login: segredo errado recusado, cookie HttpOnly/SameSite, sessão invalidada no logout', async () => {
  const anon = new Client(srv.base);
  assert.equal((await anon.login('errado')).status, 401);
  const ok = await anon.login(SECRET);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await anon.req('GET', '/api/admin/meetings')).status, 200);
  await anon.req('POST', '/api/admin/logout');
  assert.equal((await anon.req('GET', '/api/admin/meetings')).status, 401);
});

test('proteção CSRF: exige cabeçalho próprio e origem permitida', async () => {
  const noHeader = await c.req('POST', '/api/admin/meetings', { name: 'X', expectedParticipants: 2 }, { headers: { 'X-Nomeia': '0' } });
  assert.equal(noHeader.status, 403);
  const evil = await c.req('POST', '/api/admin/meetings', { name: 'X', expectedParticipants: 2 }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const cross = await c.req('POST', '/api/admin/meetings', { name: 'X', expectedParticipants: 2 }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const same = await c.req('POST', '/api/admin/meetings', { name: 'X', expectedParticipants: 2 }, { headers: { Origin: srv.base } });
  assert.equal(same.status, 201);
  // Sem CORS: nenhuma origem externa é autorizada.
  const pre = await fetch(`${srv.base}/api/meetings/m_AAAAAAAAAAAA`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('arquivos de data/ e fora de public/ nunca são servidos', async () => {
  const s = await setupMeeting(c);
  const paths = [
    `/data/meetings/${s.meetingId}.json`,
    `/../data/meetings/${s.meetingId}.json`,
    `/%2e%2e/data/meetings/${s.meetingId}.json`,
    `/..%2fdata%2fmeetings%2f${s.meetingId}.json`,
    `/..%5c..%5cpackage.json`,
    '/%2e%2e/package.json',
    '/%2e%2e/.env',
    '/.env',
    '/server.js',
    '/src/app.js',
  ];
  for (const p of paths) {
    const r = await fetch(srv.base + p);
    const text = await r.text();
    assert.equal(r.status, 404, p);
    assert.equal(text.includes('tokenHash'), false);
  }
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'meetings', `${s.meetingId}.json`)));
});

test('XSS: nomes são guardados como texto e páginas têm CSP restritiva', async () => {
  const s = await setupMeeting(c, { candidates: [] });
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const r = await c.admin('POST', s.meetingId, `/offices/${s.officeId}/candidates`, { name: evil });
  assert.equal(r.status, 201);
  const pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.candidates[0].name, evil, 'texto preservado; o front-end usa textContent');

  const page = await fetch(`${srv.base}/votar.html`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  // Nenhum script público usa innerHTML/eval.
  const jsDir = path.join(__dirname, '..', 'public', 'js');
  for (const f of fs.readdirSync(jsDir)) {
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/, f);
  }
});

test('validação de entrada: tamanho, tipo e formato', async () => {
  const big = await c.req('POST', '/api/admin/meetings', { name: 'x'.repeat(30_000), expectedParticipants: 2 });
  assert.equal(big.status, 413);
  const longName = await c.req('POST', '/api/admin/meetings', { name: 'x'.repeat(200), expectedParticipants: 2 });
  assert.equal(longName.status, 400);
  const badN = await c.req('POST', '/api/admin/meetings', { name: 'Ok', expectedParticipants: -1 });
  assert.equal(badN.status, 400);
  const notJson = await fetch(`${srv.base}/api/admin/meetings`, {
    method: 'POST',
    headers: { 'X-Nomeia': '1', Cookie: c.cookie, 'Content-Type': 'text/plain' },
    body: 'name=x',
  });
  assert.equal(notJson.status, 415);
  const broken = await fetch(`${srv.base}/api/admin/meetings`, {
    method: 'POST',
    headers: { 'X-Nomeia': '1', Cookie: c.cookie, 'Content-Type': 'application/json' },
    body: '{"name":',
  });
  assert.equal(broken.status, 400);
  const tooMany = await c.req('POST', `/api/admin/meetings/${(await setupMeeting(c, { creds: 0 })).meetingId}/credentials`, { count: 100000 });
  assert.equal(tooMany.status, 400);
  const badId = await c.req('GET', '/api/meetings/..%2f..%2fetc');
  assert.equal(badId.status, 404);
  const ctrl = await c.req('POST', '/api/admin/meetings', { name: 'Nome\u0000com‮controle', expectedParticipants: 2 });
  assert.equal(ctrl.body.name, 'Nome com controle');
});

test('tokens nunca aparecem em logs, histórico público ou snapshot administrativo', async () => {
  const s = await setupMeeting(c, { creds: 2 });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  await c.vote(s.meetingId, s.tokens[0], s.officeId, s.cands[0].id);
  await c.req('POST', '/api/credentials/check', undefined, { bearer: s.codes[1], cookie: null });
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/close`);

  const all = logs.join('\n');
  for (const secret of [...s.tokens, ...s.codes, SECRET]) assert.equal(all.includes(secret), false);

  const pub = JSON.stringify((await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body);
  const adm = JSON.stringify((await c.admin('GET', s.meetingId, '')).body);
  for (const t of [...s.tokens, ...s.codes.map((x) => x.replace(/-/g, ''))]) {
    assert.equal(pub.includes(t), false);
    assert.equal(adm.includes(t), false);
  }
  assert.equal(pub.includes('voterIds') || pub.includes('participants'), false, 'público não vê quem votou');
  assert.equal(adm.includes('tokenHash') || adm.includes('codeHash'), false);

  // Arquivo de dados: só hashes; escolha nunca associada à credencial.
  const raw = fs.readFileSync(path.join(srv.dataDir, 'meetings', `${s.meetingId}.json`), 'utf8');
  for (const t of s.tokens) assert.equal(raw.includes(t), false);
  const doc = JSON.parse(raw);
  const office = doc.offices[0];
  assert.deepEqual(Object.keys(office.tally).sort(), ['abstain', 'byCandidate']);
  assert.ok(office.voterIds.every((v) => typeof v === 'string'), 'lista de votantes sem escolhas');
});

test('rate limiting em login e tentativas de credencial', async () => {
  const limited = await startServer({
    rateLimits: { login: { limit: 3, windowMs: 60_000 }, credFail: { limit: 4, windowMs: 60_000 } },
  });
  const anon = new Client(limited.base);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await anon.login('errado')).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);

  const tries = [];
  for (let i = 0; i < 6; i++) {
    tries.push((await anon.req('POST', '/api/credentials/check', undefined, { bearer: 'AAAA-BBBB-CCCC' })).status);
  }
  assert.deepEqual(tries, [401, 401, 401, 401, 429, 429]);
  await limited.app.close();
});

test('produção exige ADMIN_SECRET forte', async () => {
  const { createApp } = require('../src/app');
  assert.throws(() => createApp({ production: true, adminSecret: '', dataDir: srv.dataDir, quiet: true }), /ADMIN_SECRET/);
  assert.throws(() => createApp({ production: true, adminSecret: 'curto', dataDir: srv.dataDir, quiet: true }), /16/);
});
