'use strict';

// Verificações estáticas do front-end publicado (PWA, telas, ausência de segredos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('página inicial: identidade, título e os três acessos principais', () => {
  const html = read('index.html');
  assert.match(html, /<title>Nomeia — Sistema de Nomeações e Votações<\/title>/);
  assert.match(html, /<h1[^>]*>Sistema de Nomeações e Votações<\/h1>/);
  assert.match(html, /id="go-admin"[\s\S]*Painel Administrativo/);
  assert.match(html, /id="go-presentation"[\s\S]*Tela de Apresentação/);
  assert.match(html, /id="go-vote"[\s\S]*Participar da Votação/);
  assert.match(html, /id="meeting-list"/);
  const js = read('js/index.js');
  assert.match(js, /listMeetings\(\)/, 'reuniões vêm do Firebase');
  assert.match(js, /Nenhuma reunião disponível/);
});

test('manifest instalável com caminhos relativos', () => {
  const mf = JSON.parse(read('manifest.webmanifest'));
  assert.equal(mf.display, 'standalone');
  assert.equal(mf.start_url, './index.html');
  assert.equal(mf.scope, './');
  assert.ok(mf.icons.some((i) => i.sizes === '192x192') && mf.icons.some((i) => i.sizes === '512x512'));
  assert.ok(mf.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of mf.icons) {
    assert.doesNotMatch(icon.src, /^\//);
    assert.ok(fs.existsSync(path.join(PUBLIC, icon.src)), icon.src);
  }
  assert.ok(fs.existsSync(path.join(PUBLIC, 'icons', 'apple-touch-icon.png')));
});

test('service worker: casca local, nunca armazena dados do Firebase nem enfileira votos', () => {
  const src = read('sw.js');
  assert.match(src, /req\.method !== 'GET'\) return/);
  assert.match(src, /url\.origin !== self\.location\.origin\) return/, 'Firebase/CDN sempre pela rede');
  assert.doesNotMatch(src, /\bsync\b|SyncManager|indexedDB/i);
  const shell = [...src.matchAll(/'([a-z][^']*\.(?:html|css|js|svg|png))'/g)].map((m) => m[1]);
  assert.ok(shell.length >= 15);
  for (const p of shell) assert.ok(fs.existsSync(path.join(PUBLIC, p)), `casca: ${p}`);
});

test('telas existem, com HTML semântico e região aria-live', () => {
  for (const page of ['index.html', 'votar.html', 'apresentacao.html', 'admin.html', 'offline.html']) {
    const html = read(page);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<main/);
    assert.match(html, /name="viewport"/);
    if (page !== 'offline.html') assert.match(html, /aria-live|role="status"|role="alert"/, page);
  }
});

test('nenhum segredo, credencial de participante ou servidor próprio no front-end', () => {
  for (const f of walk(PUBLIC).filter((x) => /\.(js|html)$/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(PUBLIC, f);
    assert.doesNotMatch(src, /ADMIN_SECRET|privateKey|private_key|serviceAccount|client_secret/i, rel);
    assert.doesNotMatch(src, /credentials\/check|Bearer |consent-yes|code-input/, `${rel}: resquício de credenciais`);
    assert.doesNotMatch(src, /\/api\/|new WebSocket|API_BASE/, `${rel}: resquício do servidor Node`);
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/, `${rel}: XSS`);
  }
  const cfg = read('js/firebase-config.js');
  assert.match(cfg, /export const firebaseConfig = null;/, 'publicação sem projeto configurado não simula dados');
  assert.match(cfg, /export const emulator = null;/, 'emulador desligado por padrão');
});

test('votação pública e sem identificação: um voto por confirmação, sem bloqueio local', () => {
  const votar = read('js/votar.js');
  assert.match(votar, /castVote\(meetingId, o\.id, selection, requestId\)/);
  assert.match(votar, /Votar novamente/);
  assert.doesNotMatch(votar, /localStorage|sessionStorage|document\.cookie/, 'nenhum bloqueio por dispositivo');
  const db = read('js/db.js');
  assert.match(db, /receipts\/\$\{meetingId\}\/\$\{officeId\}\/\$\{requestId\}/);
  assert.match(db, /tallies\/\$\{meetingId\}\/\$\{officeId\}\/\$\{choice\}`\]: d\.increment\(1\)/);
  assert.match(db, /if \(!connected\) throw new DataError\('network_error'/, 'não enfileira votos offline');
});

test('painel administrativo depende do Firebase Authentication + regras, não só da interface', () => {
  const admin = read('js/admin.js');
  assert.match(admin, /db\.watchAdmin\(/);
  assert.match(admin, /db\.signIn\(/);
  const html = read('admin.html');
  assert.match(html, /id="email"[^>]*type="email"/);
  assert.match(html, /id="secret"[^>]*type="password"/);
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8'));
  assert.match(rules.rules.meetings.$mid['.write'], /root\.child\('admins'\)\.child\(auth\.uid\)\.val\(\) === true/);
  assert.equal(rules.rules['.write'], false);
  assert.equal(rules.rules.admins.$uid['.write'], false);
});
