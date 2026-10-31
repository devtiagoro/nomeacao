'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { HttpError } = require('./domain');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

function safeHost(req, cfg) {
  const fwd = cfg.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const host = fwd || req.headers.host || '';
  return HOST_RE.test(host) ? host : 'localhost';
}

function requestProto(req, cfg) {
  if (cfg.trustProxy) {
    const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (p === 'https' || p === 'http') return p;
  }
  return cfg.tls ? 'https' : 'http';
}

function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/** Origem pública para links e QR Codes. "localhost" é trocado pelo IP da rede local. */
function publicBase(req, cfg) {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  const proto = requestProto(req, cfg);
  let host = safeHost(req, cfg);
  const [name, port] = host.startsWith('[') ? [host.slice(0, host.indexOf(']') + 1), host.split(']:')[1]] : host.split(':');
  if (['localhost', '127.0.0.1', '[::1]'].includes(name)) {
    const ip = lanAddress();
    if (ip) host = port ? `${ip}:${port}` : ip;
  }
  return `${proto}://${host}`;
}

function isAllowedOrigin(origin, req, cfg) {
  if (!origin) return false;
  const own = `${requestProto(req, cfg)}://${safeHost(req, cfg)}`;
  return origin === own || origin === cfg.publicOrigin || cfg.allowedOrigins.includes(origin);
}

function securityHeaders(req, res, cfg) {
  const host = safeHost(req, cfg);
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (cfg.production || requestProto(req, cfg) === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function sendError(res, err, log) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  }
  log.error(`Erro interno: ${err && err.stack ? err.stack : err}`);
  return sendJson(res, 500, { error: { code: 'internal_error', message: 'Erro interno. Tente novamente.' } });
}

/** Lê e interpreta corpo JSON com limite de tamanho. */
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new HttpError(413, 'payload_too_large', 'Requisição muito grande.'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, 'payload_too_large', 'Requisição muito grande.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size === 0) return resolve({});
      if (!type.startsWith('application/json')) {
        return reject(new HttpError(415, 'unsupported_media_type', 'Envie application/json.'));
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'JSON inválido.'));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

/** Serve somente arquivos dentro de public/. Bloqueia travessia de diretório e arquivos ocultos. */
async function serveStatic(req, res, cfg, pathname, transform) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Método não permitido.' } });
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return notFound(res);
  const file = path.resolve(cfg.publicDir, '.' + path.posix.normalize(rel));
  if (!file.startsWith(cfg.publicDir + path.sep)) return notFound(res);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return notFound(res);
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) return notFound(res);
  } catch {
    return notFound(res);
  }
  let body = await fsp.readFile(file);
  if (transform) body = await transform(rel, body);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${body.length.toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function notFound(res) {
  sendJson(res, 404, { error: { code: 'not_found', message: 'Não encontrado.' } });
}

module.exports = {
  safeHost,
  requestProto,
  clientIp,
  publicBase,
  isAllowedOrigin,
  securityHeaders,
  sendJson,
  sendError,
  readJson,
  serveStatic,
  notFound,
};
