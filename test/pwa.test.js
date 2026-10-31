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

test('página inicial: identidade, título e os três acessos principais', async () => {
  for (const p of ['/', '/index.html']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /<title>Nomeia — Sistema de Nomeações e Votações<\/title>/);
    assert.match(html, /<h1[^>]*>Sistema de Nomeações e Votações<\/h1>/);
    assert.match(html, /id="go-admin"[\s\S]*Painel Administrativo/);
    assert.match(html, /id="go-presentation"[\s\S]*Tela de Apresentação/);
    assert.match(html, /id="go-vote"[\s\S]*Participar da Votação/);
    assert.match(html, /id="meeting-list"/, 'seletor de reunião');
    assert.doesNotMatch(html, /README|credencial/i);
  }
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'index.js'), 'utf8');
  assert.match(js, /api\('\/api\/meetings'\)/, 'carrega as reuniões disponíveis');
  assert.match(js, /Nenhuma reunião disponível/, 'orienta a criar uma reunião');
});

test('manifest instalável com caminhos relativos e vinculado à reunião', async () => {
  const base = await (await fetch(`${srv.base}/manifest.webmanifest`)).json();
  assert.equal(base.display, 'standalone');
  assert.equal(base.start_url, './index.html');
  assert.equal(base.scope, './');
  const sizes = base.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(base.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of base.icons) {
    assert.doesNotMatch(icon.src, /^\//, 'ícone com caminho relativo');
    assert.equal((await fetch(`${srv.base}/${icon.src}`)).status, 200, icon.src);
  }
  const s = await setupMeeting(srv.client);
  const bound = await (await fetch(`${srv.base}/manifest.webmanifest?m=${s.meetingId}`)).json();
  assert.equal(bound.start_url, `./votar.html?m=${s.meetingId}`);
});

test('service worker não armazena API nem enfileira votos; casca com caminhos relativos', async () => {
  const r = await fetch(`${srv.base}/sw.js`);
  assert.equal(r.status, 200);
  const src = await r.text();
  assert.match(src, /req\.method !== 'GET'\) return/);
  assert.match(src, /startsWith\('\/api\/'\)/);
  assert.match(src, /url\.origin !== self\.location\.origin\) return/, 'API em outra origem nunca é interceptada');
  assert.doesNotMatch(src, /\bsync\b|SyncManager|indexedDB/i, 'sem background sync nem fila de votos');
  const shell = [...src.matchAll(/'([a-z][^']*\.(?:html|css|js|svg|png))'/g)].map((m) => m[1]);
  assert.ok(shell.length >= 10);
  for (const p of shell) assert.equal((await fetch(`${srv.base}/${p}`)).status, 200, p);
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
});

test('nenhum segredo nem credencial no front-end público', () => {
  const dir = path.join(__dirname, '..', 'public');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir).filter((x) => /\.(js|html)$/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /ADMIN_SECRET\s*[:=]\s*['"][^'"]+/, f);
    assert.doesNotMatch(src, /segredo-de-teste/, f);
    assert.doesNotMatch(src, /credentials\/check|Authorization|Bearer|consent-yes|code-input/, `${f}: resquício de credenciais`);
  }
});
