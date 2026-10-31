'use strict';

const { WebSocketServer } = require('ws');
const { publicSnapshot, adminSnapshot, ID_RE } = require('./domain');
const { parseCookies } = require('./security');
const { isAllowedOrigin, clientIp } = require('./http');

const EVENTS = new Set([
  'snapshot',
  'meeting_updated',
  'office_updated',
  'candidates_updated',
  'vote_opened',
  'vote_accepted',
  'turnout_updated',
  'vote_closed',
  'results_published',
  'next_office',
  'meeting_closed',
]);

const HEARTBEAT_MS = 25_000;
const MAX_CONNECTIONS = 5000;

/**
 * Canal /ws?meeting=<id>[&role=admin]. O servidor só envia; o cliente pode mandar
 * {type:"ping"} ou {type:"sync"}. Cada mensagem carrega o snapshot completo e a
 * versão da reunião, então mensagens duplicadas ou fora de ordem são inofensivas.
 */
class Hub {
  constructor({ server, store, cfg, sessions, limiter, cookieName, log }) {
    this.store = store;
    this.cfg = cfg;
    this.sessions = sessions;
    this.limiter = limiter;
    this.cookieName = cookieName;
    this.log = log;
    this.rooms = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });

    server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
    this.heartbeat = setInterval(() => this._beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  _reject(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  _upgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return this._reject(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/ws') return this._reject(socket, 404, 'Not Found');
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, req, this.cfg)) return this._reject(socket, 403, 'Forbidden');
    if (!this.limiter.hit('wsConnect', clientIp(req, this.cfg))) return this._reject(socket, 429, 'Too Many Requests');
    if (this.wss.clients.size >= MAX_CONNECTIONS) return this._reject(socket, 503, 'Service Unavailable');

    const meetingId = url.searchParams.get('meeting') || '';
    const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'public';
    const sid = parseCookies(req.headers.cookie)[this.cookieName];

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Erros de autorização/inexistência são enviados pelo próprio socket com códigos 44xx,
      // para que o cliente diferencie de queda de rede e não fique reconectando à toa.
      if (!ID_RE.test(meetingId) || !this.store.get(meetingId)) {
        ws.close(4404, 'meeting_not_found');
        return;
      }
      if (role === 'admin' && !this.sessions.valid(sid)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      ws.meetingId = meetingId;
      ws.role = role;
      ws.sid = sid;
      ws.isAlive = true;
      this._join(ws);
    });
  }

  _join(ws) {
    let room = this.rooms.get(ws.meetingId);
    if (!room) this.rooms.set(ws.meetingId, (room = new Set()));
    room.add(ws);
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (msg && msg.type === 'ping') this._send(ws, { type: 'pong', at: Date.now() });
      else if (msg && msg.type === 'sync') this._sendState(ws, 'snapshot');
    });
    ws.on('close', () => {
      room.delete(ws);
      if (!room.size) this.rooms.delete(ws.meetingId);
    });
    ws.on('error', () => {});
    this._sendState(ws, 'snapshot');
  }

  _send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  _payload(m, type, role) {
    return JSON.stringify({
      type,
      meetingId: m.id,
      version: m.version,
      at: new Date().toISOString(),
      state: role === 'admin' ? adminSnapshot(m) : publicSnapshot(m),
    });
  }

  _sendState(ws, type) {
    const m = this.store.get(ws.meetingId);
    if (!m) return ws.close(4404, 'meeting_not_found');
    if (ws.role === 'admin' && !this.sessions.valid(ws.sid)) return ws.close(4401, 'unauthorized');
    this._send(ws, this._payload(m, type, ws.role));
  }

  /** Envia o estado atual da reunião a todos os conectados, com o tipo de evento. */
  broadcast(meetingId, type) {
    if (!EVENTS.has(type)) throw new Error(`evento desconhecido: ${type}`);
    const room = this.rooms.get(meetingId);
    const m = this.store.get(meetingId);
    if (!room || !m) return;
    let pub = null;
    let adm = null;
    for (const ws of room) {
      if (ws.role === 'admin') {
        if (!this.sessions.valid(ws.sid)) {
          ws.close(4401, 'unauthorized');
          continue;
        }
        this._send(ws, (adm ??= this._payload(m, type, 'admin')));
      } else {
        this._send(ws, (pub ??= this._payload(m, type, 'public')));
      }
    }
  }

  _beat() {
    for (const ws of this.wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* conexão já encerrada */
      }
    }
  }

  connectionCount(meetingId) {
    return this.rooms.get(meetingId)?.size || 0;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

module.exports = { Hub, EVENTS };
