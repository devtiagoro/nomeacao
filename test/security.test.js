'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, setupMeeting, Client, SECRET, rid } = require('./helpers');

const PAGES = 'https://devtiagoro.github.io';
let srv;
let c;
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

test.before(async () => {
  srv = await startServer({ log, publicAppUrl: `${PAGES}/nomeacao/public/` });
  c = srv.client;
  await c.login();
});

test.after(() => srv.app.close());

test('acesso público não consegue alterar a reunião (proteção administrativa)', async () => {
  const s = await setupMeeting(c);
  const anon = new Client(srv.base);
  const attempts = [
    ['GET', '/api/admin/meetings'],
    ['POST', '/api/admin/meetings', { name: 'X', expectedParticipants: 3 }],
    ['GET', `/api/admin/meetings/${s.meetingId}`],
    ['PATCH', `/api/admin/meetings/${s.meetingId}`, { name: 'Hackeada' }],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices`, { title: 'X' }],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/candidates`, { name: 'Intruso' }],
    ['DELETE', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/candidates/${s.cands[0].id}`],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/open`],
    ['POST', `/api/admin/meetings/${s.meetingId}/offices/${s.officeId}/close`],
    ['POST', `/api/admin/meetings/${s.meetingId}/archive`],
    ['GET', `/api/admin/meetings/${s.meetingId}/export.json`],
    ['POST', '/api/admin/import', { format: 'nomeia-export' }],
  ];
  for (const [method, p, body] of attempts) assert.equal((await anon.req(method, p, body)).status, 401, `${method} ${p}`);
  const snap = (await c.admin('GET', s.meetingId, '')).body;
  assert.equal(snap.offices[0].status, 'discussing');
  assert.equal(snap.offices[0].candidates.length, 2);
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

test('proteção CSRF: cabeçalho próprio e origem conferida', async () => {
  const body = { name: 'X', expectedParticipants: 2 };
  assert.equal((await c.req('POST', '/api/admin/meetings', body, { headers: { 'X-Nomeia': '0' } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/meetings', body, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/meetings', body, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  // Mesmo a origem autorizada do GitHub Pages não executa ações administrativas.
  assert.equal((await c.req('POST', '/api/admin/meetings', body, { headers: { Origin: PAGES } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/meetings', body, { headers: { Origin: srv.base } })).status, 201);
});

test('CORS: somente a API pública e somente para a origem publicada', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);

  const pre = await fetch(`${srv.base}/api/meetings/${s.meetingId}/votes`, {
    method: 'OPTIONS',
    headers: { Origin: PAGES, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-nomeia' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), PAGES);
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Nomeia/);
  assert.equal(pre.headers.get('access-control-allow-credentials'), null, 'sem cookies entre origens');

  // Voto vindo do GitHub Pages (cross-site) é aceito.
  const v = await c.vote(s.meetingId, s.officeId, s.cands[0].id, rid(), { Origin: PAGES, 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(v.status, 201);
  assert.equal(v.headers.get('access-control-allow-origin'), PAGES);

  // Origem desconhecida: sem CORS e voto recusado.
  const evilPre = await fetch(`${srv.base}/api/meetings/${s.meetingId}/votes`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(evilPre.status, 403);
  assert.equal(evilPre.headers.get('access-control-allow-origin'), null);
  assert.equal((await c.vote(s.meetingId, s.officeId, s.cands[0].id, rid(), { Origin: 'https://evil.example' })).status, 403);

  // Rotas administrativas nunca recebem cabeçalhos CORS.
  const adm = await fetch(`${srv.base}/api/admin/session`, { headers: { Origin: PAGES } });
  assert.equal(adm.headers.get('access-control-allow-origin'), null);
  const admPre = await fetch(`${srv.base}/api/admin/meetings`, { method: 'OPTIONS', headers: { Origin: PAGES } });
  assert.equal(admPre.status, 403);

  // QR Code pode ser exibido pela apresentação hospedada em outra origem.
  const qr = await fetch(`${srv.base}/api/meetings/${s.meetingId}/qr.svg`);
  assert.equal(qr.headers.get('cross-origin-resource-policy'), 'cross-origin');
  // Links e QR apontam para o front-end publicado.
  const link = await c.req('GET', `/api/meetings/${s.meetingId}/link`, undefined, { cookie: null });
  assert.equal(link.body.publicUrl, `${PAGES}/nomeacao/public/votar.html?m=${s.meetingId}`);
});

test('arquivos de data/ e fora de public/ nunca são servidos', async () => {
  const s = await setupMeeting(c);
  const paths = [
    `/data/meetings/${s.meetingId}.json`,
    `/../data/meetings/${s.meetingId}.json`,
    `/%2e%2e/data/meetings/${s.meetingId}.json`,
    `/..%2fdata%2fmeetings%2f${s.meetingId}.json`,
    '/..%5c..%5cpackage.json',
    '/%2e%2e/.env',
    '/.env',
    '/.nojekyll',
    '/server.js',
    '/src/app.js',
  ];
  for (const p of paths) assert.equal((await fetch(srv.base + p)).status, 404, p);
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'meetings', `${s.meetingId}.json`)));
});

test('XSS: nomes são guardados como texto e páginas têm CSP restritiva', async () => {
  const s = await setupMeeting(c, { candidates: [] });
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  assert.equal((await c.admin('POST', s.meetingId, `/offices/${s.officeId}/candidates`, { name: evil })).status, 201);
  const pub = (await c.req('GET', `/api/meetings/${s.meetingId}`, undefined, { cookie: null })).body;
  assert.equal(pub.currentOffice.candidates[0].name, evil);
  const page = await fetch(`${srv.base}/votar.html`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const jsDir = path.join(__dirname, '..', 'public', 'js');
  for (const f of fs.readdirSync(jsDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(jsDir, f), 'utf8'), /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/, f);
  }
});

test('validação de entrada: tamanho, tipo e formato', async () => {
  assert.equal((await c.req('POST', '/api/admin/meetings', { name: 'x'.repeat(30_000), expectedParticipants: 2 })).status, 413);
  assert.equal((await c.req('POST', '/api/admin/meetings', { name: 'x'.repeat(200), expectedParticipants: 2 })).status, 400);
  assert.equal((await c.req('POST', '/api/admin/meetings', { name: 'Ok', expectedParticipants: -1 })).status, 400);
  const notJson = await fetch(`${srv.base}/api/admin/meetings`, {
    method: 'POST',
    headers: { 'X-Nomeia': '1', Cookie: c.cookie, 'Content-Type': 'text/plain' },
    body: 'name=x',
  });
  assert.equal(notJson.status, 415);
  assert.equal((await c.req('GET', '/api/meetings/..%2f..%2fetc')).status, 404);
  const ctrl = await c.req('POST', '/api/admin/meetings', { name: 'Nome\u0000com‮controle', expectedParticipants: 2 });
  assert.equal(ctrl.body.name, 'Nome com controle');
});

test('logs não registram corpo nem segredo; votos não carregam identificação', async () => {
  const s = await setupMeeting(c);
  await c.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const id = rid();
  await c.vote(s.meetingId, s.officeId, s.cands[0].id, id);
  const all = logs.join('\n');
  assert.equal(all.includes(SECRET), false);
  assert.equal(all.includes(id), false);
  const raw = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'meetings', `${s.meetingId}.json`), 'utf8'));
  assert.deepEqual(Object.keys(raw.offices[0].tally).sort(), ['abstain', 'byCandidate']);
  assert.equal('participants' in raw, false);
  // requestId é aleatório e fica separado da escolha (não há vínculo voto → opção).
  assert.deepEqual(raw.offices[0].requestIds, [id]);
});

test('rate limiting no login administrativo; votos não têm limite por IP', async () => {
  const limited = await startServer({ rateLimits: { login: { limit: 3, windowMs: 60_000 } } });
  await limited.client.login();
  const anon = new Client(limited.base);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await anon.login('errado')).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);

  // Com os limites padrão, 120 votos seguidos do mesmo IP são todos aceitos.
  const s = await setupMeeting(limited.client);
  await limited.client.admin('POST', s.meetingId, `/offices/${s.officeId}/open`);
  const res = await Promise.all(Array.from({ length: 120 }, () => limited.client.vote(s.meetingId, s.officeId, s.cands[0].id)));
  assert.ok(res.every((r) => r.status === 201));
  await limited.app.close();
});

test('produção exige ADMIN_SECRET forte', () => {
  const { createApp } = require('../src/app');
  assert.throws(() => createApp({ production: true, adminSecret: '', dataDir: srv.dataDir, quiet: true }), /ADMIN_SECRET/);
  assert.throws(() => createApp({ production: true, adminSecret: 'curto', dataDir: srv.dataDir, quiet: true }), /16/);
});
