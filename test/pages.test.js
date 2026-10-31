'use strict';

// Simula a publicação no GitHub Pages: o repositório inteiro servido como arquivos estáticos
// sob o subcaminho /nomeacao/ (sem servidor próprio). Verifica que nenhum caminho absoluto
// quebra CSS, JavaScript, ícones ou navegação.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const BASE_PATH = '/nomeacao/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let server;
let origin;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE_PATH)) {
      res.writeHead(404);
      return res.end();
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE_PATH.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((r) => server.close(r)));

const get = async (url) => {
  const r = await fetch(url);
  return { status: r.status, text: r.status === 200 ? await r.text() : '' };
};

test('raiz publicada (/nomeacao/) abre a página inicial com as três opções, sem avisos técnicos', async () => {
  const root = await get(`${origin}${BASE_PATH}`);
  assert.equal(root.status, 200);
  assert.doesNotMatch(root.text, /# NOMEIA|README/);
  const target = /url=([^"]+)"/.exec(root.text)[1];
  assert.equal(target, 'public/index.html');
  assert.match(root.text, /location\.replace\('public\/index\.html' \+ location\.search \+ location\.hash\)/);
  const app = await get(new URL(target, `${origin}${BASE_PATH}`).href);
  assert.equal(app.status, 200);
  assert.match(app.text, /Nomeações e Votações/);
  for (const p of ['admin.html', 'apresentacao.html', 'votar.html']) assert.match(app.text, new RegExp(`href="${p}"`), `início leva a ${p}`);
  assert.doesNotMatch(app.text, /firebase|configura|README/i, 'nenhum aviso técnico na página inicial');
  assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')), '.nojekyll na raiz publicada');
});

test('todos os recursos e links das páginas resolvem sob /nomeacao/public/', async () => {
  const pages = ['index.html', 'votar.html', 'apresentacao.html', 'admin.html'];
  const checked = new Set();
  const failures = [];

  async function check(url, from) {
    if (checked.has(url)) return;
    checked.add(url);
    if (!url.startsWith(`${origin}${BASE_PATH}`)) return failures.push(`${from} → ${url} (fora de ${BASE_PATH})`);
    const r = await get(url);
    if (r.status !== 200) return failures.push(`${from} → ${url} (${r.status})`);
    if (url.endsWith('.js')) {
      for (const m of r.text.matchAll(/(?:import\s[^'"]*from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) await check(new URL(m[1], url).href, url);
    }
  }

  for (const page of pages) {
    const pageUrl = `${origin}${BASE_PATH}public/${page}`;
    const r = await get(pageUrl);
    assert.equal(r.status, 200, page);
    for (const m of r.text.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(#|https?:|mailto:|data:)/.test(ref)) continue;
      await check(new URL(ref, pageUrl).href.split('?')[0].split('#')[0], page);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(checked.size >= 15, `recursos verificados: ${checked.size}`);
});

test('navegação gerada pelo JavaScript usa caminhos relativos', () => {
  const files = [
    ...fs.readdirSync(path.join(PUBLIC, 'js')).map((f) => path.join(PUBLIC, 'js', f)),
    ...fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => path.join(PUBLIC, f)),
    ...fs.readdirSync(path.join(PUBLIC, 'css')).map((f) => path.join(PUBLIC, 'css', f)),
  ];
  const absolute = /['"`(]\/(?!\/)[A-Za-z0-9_.-]+\.(?:html|js|css|png|svg)\b/;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => assert.doesNotMatch(line, absolute, `${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`));
  }
  // O QR Code e o link público apontam para a tela de votação, relativa ao endereço publicado.
  for (const f of ['apresentacao.js', 'admin.js']) assert.match(fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8'), /pageUrl\('votar\.html'\)/, f);
});

test('sem Firebase configurado nada é simulado; dependências externas com versão fixa', () => {
  const db = fs.readFileSync(path.join(PUBLIC, 'js', 'db.js'), 'utf8');
  assert.match(db, /export const configured = Boolean\(firebaseConfig && firebaseConfig\.apiKey && firebaseConfig\.databaseURL\)/);
  for (const page of ['votar.js', 'apresentacao.js', 'admin.js']) {
    assert.match(fs.readFileSync(path.join(PUBLIC, 'js', page), 'utf8'), /configured/, `${page} verifica a configuração`);
  }
  // Apenas o SDK oficial do Firebase e a biblioteca de QR Code vêm de CDN, com versão fixa.
  assert.match(db, /https:\/\/www\.gstatic\.com\/firebasejs\/12\.19\.0/);
  assert.match(db, /https:\/\/cdn\.jsdelivr\.net\/npm\/qrcode@1\.5\.4\/\+esm/);
});
