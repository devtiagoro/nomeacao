'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { createApp } = require('../src/app');

const SECRET = 'segredo-de-teste-0123456789';
const NO_LIMITS = Object.fromEntries(['global', 'login', 'admin', 'wsConnect'].map((k) => [k, { limit: 1e9, windowMs: 60_000 }]));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nomeia-test-'));
}

/** Identificador de uma confirmação de voto (como o navegador gera). */
const rid = () => crypto.randomBytes(16).toString('hex');

async function startServer({ dataDir = tmpDir(), rateLimits = NO_LIMITS, log, ...rest } = {}) {
  const app = createApp({ dataDir, adminSecret: SECRET, port: 0, host: '127.0.0.1', quiet: true, rateLimits, log, ...rest });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  return { app, base, dataDir, client: new Client(base) };
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
  }

  async req(method, p, body, { cookie = this.cookie, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (method !== 'GET' && !('X-Nomeia' in h) && !('x-nomeia' in h)) h['X-Nomeia'] = '1';
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const res = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  async login(secret = SECRET) {
    const r = await this.req('POST', '/api/admin/login', { secret }, { cookie: null });
    if (r.status === 200) this.cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  }

  admin(method, meetingId, suffix, body) {
    return this.req(method, `/api/admin/meetings/${meetingId}${suffix}`, body);
  }

  /** Voto público: sem cookie, sem credencial. Um requestId por confirmação. */
  vote(meetingId, officeId, choice, requestId = rid(), headers = {}) {
    return this.req('POST', `/api/meetings/${meetingId}/votes`, { officeId, choice, requestId }, { cookie: null, headers });
  }
}

/** Cria reunião + cargo em discussão + candidatos. */
async function setupMeeting(client, { expected = 10, candidates = ['Ana', 'Bruno'], title = 'Presidente' } = {}) {
  const m = await client.req('POST', '/api/admin/meetings', { name: 'Assembleia de teste', expectedParticipants: expected });
  if (m.status !== 201) throw new Error(`create meeting ${m.status} ${JSON.stringify(m.body)}`);
  const meetingId = m.body.id;
  const o = await client.admin('POST', meetingId, '/offices', { title });
  const officeId = o.body.officeId;
  for (const name of candidates) await client.admin('POST', meetingId, `/offices/${officeId}/candidates`, { name });
  const snap = (await client.admin('GET', meetingId, '')).body;
  const cands = snap.offices.find((x) => x.id === officeId).candidates;
  return { meetingId, officeId, cands };
}

async function newOffice(client, meetingId, title, candidates) {
  const o = await client.admin('POST', meetingId, '/offices', { title });
  if (o.status !== 201) throw new Error(`office ${o.status} ${JSON.stringify(o.body)}`);
  for (const name of candidates) await client.admin('POST', meetingId, `/offices/${o.body.officeId}/candidates`, { name });
  const snap = (await client.admin('GET', meetingId, '')).body;
  return { officeId: o.body.officeId, cands: snap.offices.find((x) => x.id === o.body.officeId).candidates };
}

/** Cliente WebSocket que guarda as mensagens e permite aguardar uma condição. */
function wsClient(base, meetingId, { role, cookie, origin } = {}) {
  const url = `${base.replace('http', 'ws')}/ws?meeting=${meetingId}${role === 'admin' ? '&role=admin' : ''}`;
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(url, { headers });
  ws.on('error', () => {});
  const messages = [];
  const waiters = [];
  let closeInfo = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) w.resolve(msg);
  });
  ws.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
    for (const w of [...waiters]) if (w.onClose) w.onClose(closeInfo);
  });
  return {
    ws,
    messages,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    }),
    waitFor(pred, ms = 3000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve: (m) => {
            clearTimeout(t);
            waiters.splice(waiters.indexOf(w), 1);
            resolve(m);
          },
        };
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout aguardando mensagem; recebidas: ${messages.map((m) => m.type).join(',')}`));
        }, ms);
        waiters.push(w);
      });
    },
    closed(ms = 3000) {
      if (closeInfo) return Promise.resolve(closeInfo);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout aguardando close')), ms);
        waiters.push({ pred: () => false, onClose: (i) => (clearTimeout(t), resolve(i)) });
      });
    },
    close() {
      ws.terminate();
    },
  };
}

module.exports = { SECRET, NO_LIMITS, tmpDir, rid, startServer, Client, setupMeeting, newOffice, wsClient };
