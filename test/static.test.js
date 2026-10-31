'use strict';

// Verificações estáticas do front-end publicado (telas, ausência de segredos e de bloqueios).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('página inicial: três acessos e nenhum script de dados', () => {
  const html = read('index.html');
  assert.match(html, /id="go-admin"[\s\S]*Administração/);
  assert.match(html, /id="go-presentation"[\s\S]*Apresentação/);
  assert.match(html, /id="go-vote"[\s\S]*Votação pública/);
  assert.doesNotMatch(html, /db\.js|firebase/i);
});

test('telas existem, com HTML semântico e região de status', () => {
  for (const page of ['index.html', 'votar.html', 'apresentacao.html', 'admin.html']) {
    const html = read(page);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<main/);
    assert.match(html, /name="viewport"/);
    if (page !== 'index.html') assert.match(html, /aria-live|role="status"|role="alert"/, page);
  }
});

test('sem service worker ativo, manifest ou página offline (sw.js apenas remove versões antigas)', () => {
  for (const f of walk(PUBLIC).filter((x) => /\.(js|html)$/.test(x) && !x.endsWith('sw.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /serviceWorker\.register|manifest\.webmanifest|offline\.html/, path.relative(PUBLIC, f));
  }
  const sw = read('sw.js');
  assert.match(sw, /registration\.unregister\(\)/);
  assert.doesNotMatch(sw, /addEventListener\('fetch'/);
});

test('nenhum segredo, credencial de participante ou servidor próprio no front-end', () => {
  for (const f of walk(PUBLIC).filter((x) => /\.(js|html)$/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(PUBLIC, f);
    assert.doesNotMatch(src, /ADMIN_SECRET|privateKey|private_key|serviceAccount|client_secret/i, rel);
    assert.doesNotMatch(src, /credentials\/check|Bearer |code-input|participantCode|voterCard/, `${rel}: resquício de credenciais`);
    assert.doesNotMatch(src, /\/api\/|new WebSocket|API_BASE/, `${rel}: resquício do servidor Node`);
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/, `${rel}: XSS`);
  }
  const cfg = read('js/firebase-config.js');
  assert.match(cfg, /export const emulator = null;/, 'emulador desligado por padrão');
});

test('votação pública: sem login nem bloqueio por aparelho; segue a reunião em andamento', () => {
  const votar = read('js/votar.js');
  assert.match(votar, /castBallot\(meetingId, o\.id, choices, requestId\)/);
  assert.match(votar, /ballotChoices\(o, \[\.\.\.selection\]\)/, 'cédula validada para escolha única e múltipla');
  assert.match(votar, /Votar novamente/);
  assert.match(votar, /Voto registrado/);
  assert.match(votar, /watchCurrent\(follow\)/, 'próximo cargo e nova reunião sem ler o QR Code de novo');
  assert.doesNotMatch(votar, /localStorage|sessionStorage|document\.cookie|signIn/, 'nenhum bloqueio por dispositivo nem login');
  assert.match(read('js/apresentacao.js'), /watchCurrent\(follow\)/);
  const db = read('js/db.js');
  assert.match(db, /receipts\/\$\{meetingId\}\/\$\{officeId\}\/\$\{requestId\}/);
  assert.match(db, /for \(const c of choices\) upd\[`tallies\/\$\{meetingId\}\/\$\{officeId\}\/\$\{c\}`\] = d\.increment\(1\)/, 'um voto por nome marcado');
  assert.match(db, /\[`counts\/\$\{meetingId\}\/\$\{officeId\}`\]: d\.increment\(1\)/, 'uma cédula por confirmação');
  assert.match(db, /if \(!connected\) throw new DataError\('network_error'/, 'não enfileira votos offline');
});

test('administração depende do Firebase Authentication + regras, não só da interface', () => {
  const admin = read('js/admin.js');
  assert.match(admin, /db\.watchAdmin\(/);
  assert.match(admin, /db\.signIn\(/);
  for (const fn of ['presentOffice', 'openVoting', 'closeVoting', 'createOffice', 'addCandidate', 'renameCandidate', 'removeCandidate', 'exportMeeting']) {
    assert.match(admin, new RegExp(`db\\.${fn}\\(`), fn);
  }
  const html = read('admin.html');
  assert.match(html, /id="email"[^>]*type="email"/);
  assert.match(html, /id="secret"[^>]*type="password"/);
  assert.match(html, /name="o-type" value="single"/);
  assert.match(html, /name="o-type" value="multiple"/);
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8')).rules;
  const isAdmin = /root\.child\('admins'\)\.child\(auth\.uid\)\.val\(\) === true/;
  assert.equal(rules['.write'], false);
  assert.equal(rules.admins.$uid['.write'], false);
  assert.match(rules.current['.write'], isAdmin);
  assert.match(rules.meetings.$mid['.write'], isAdmin);
  assert.match(rules.meetings.$mid.offices.$oid['.write'], isAdmin);
  assert.match(rules.meetings.$mid.offices.$oid['.write'], /data\.child\('status'\)\.val\(\) !== 'closed'/, 'cargo encerrado é definitivo');
});
