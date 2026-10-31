'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, setupMeeting } = require('./helpers');

let srv;

test.before(async () => {
  srv = await startServer();
  await srv.client.login();
});

test.after(() => srv.app.close());

test('manifest instalável e vinculado à reunião', async () => {
  const base = await (await fetch(`${srv.base}/manifest.webmanifest`)).json();
  assert.equal(base.display, 'standalone');
  assert.equal(base.start_url, '/index.html');
  const sizes = base.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(base.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of base.icons) {
    const r = await fetch(srv.base + icon.src);
    assert.equal(r.status, 200, icon.src);
  }
  assert.equal((await fetch(`${srv.base}/icons/apple-touch-icon.png`)).status, 200);

  const s = await setupMeeting(srv.client, { creds: 0 });
  const res = await fetch(`${srv.base}/manifest.webmanifest?m=${s.meetingId}`);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
  const bound = await res.json();
  assert.equal(bound.start_url, `/votar.html?m=${s.meetingId}`);

  const unknown = await (await fetch(`${srv.base}/manifest.webmanifest?m=m_AAAAAAAAAAAA`)).json();
  assert.equal(unknown.start_url, '/index.html');
});

test('service worker não armazena API nem enfileira votos', async () => {
  const r = await fetch(`${srv.base}/sw.js`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const src = await r.text();
  assert.match(src, /req\.method !== 'GET'\) return/);
  assert.match(src, /startsWith\('\/api\/'\)/);
  assert.match(src, /offline\.html/);
  assert.doesNotMatch(src, /\bsync\b|SyncManager|indexedDB/i, 'sem background sync nem fila de votos');

  // Todos os arquivos da casca existem.
  const shell = [...src.matchAll(/'(\/[^']+\.(?:html|css|js|svg|png))'/g)].map((m) => m[1]);
  assert.ok(shell.length >= 10);
  for (const p of shell) assert.equal((await fetch(srv.base + p)).status, 200, p);
});

test('páginas principais existem, com HTML semântico e região aria-live', async () => {
  for (const page of ['index.html', 'votar.html', 'apresentacao.html', 'admin.html', 'offline.html']) {
    const r = await fetch(`${srv.base}/${page}`);
    assert.equal(r.status, 200, page);
    const html = await r.text();
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<main/);
    assert.match(html, /name="viewport"/);
    if (page !== 'offline.html') assert.match(html, /aria-live|role="status"|role="alert"/, page);
  }
  const root = await fetch(`${srv.base}/`);
  assert.equal(root.status, 200);
});

test('nenhum segredo administrativo no JavaScript público', () => {
  const dir = path.join(__dirname, '..', 'public');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir).filter((x) => /\.(js|html)$/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /ADMIN_SECRET\s*[:=]\s*['"][^'"]+/);
    assert.doesNotMatch(src, /segredo-de-teste/);
  }
});
