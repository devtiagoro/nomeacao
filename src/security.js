'use strict';

const crypto = require('node:crypto');

// Alfabeto sem caracteres ambíguos (sem 0/O, 1/I/L): 31 símbolos.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 12; // ~59 bits; força bruta inviável com rate limiting.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Comparação em tempo constante de dois hashes hex de mesmo tamanho. */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Comparação em tempo constante de strings arbitrárias (via hash). */
function safeEqualText(a, b) {
  return safeEqualHex(sha256(String(a)), sha256(String(b)));
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function newCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function formatCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

/**
 * Normaliza uma credencial (token de link/QR ou código digitado) e devolve o hash
 * pelo qual ela é indexada. Retorna null se o formato for inválido.
 */
function credentialHash(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (TOKEN_RE.test(trimmed)) return sha256('tok:' + trimmed);
  const code = trimmed.toUpperCase().replace(/[\s-]/g, '');
  if (code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c))) {
    return sha256('code:' + code);
  }
  return null;
}

function tokenHash(token) {
  return sha256('tok:' + token);
}

function codeHash(code) {
  return sha256('code:' + code);
}

/** Rate limiter em memória com janela fixa por chave. */
class RateLimiter {
  constructor(limits) {
    this.limits = limits;
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** Retorna true se a ação é permitida (e a contabiliza). */
  hit(bucket, key) {
    const rule = this.limits[bucket];
    if (!rule) return true;
    const k = `${bucket}:${key}`;
    const now = Date.now();
    let entry = this.buckets.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + rule.windowMs };
      this.buckets.set(k, entry);
    }
    entry.count++;
    return entry.count <= rule.limit;
  }

  /** Verifica sem contabilizar. */
  blocked(bucket, key) {
    const rule = this.limits[bucket];
    const entry = this.buckets.get(`${bucket}:${key}`);
    return Boolean(rule && entry && entry.reset > Date.now() && entry.count >= rule.limit);
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.buckets) if (v.reset <= now) this.buckets.delete(k);
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** Sessões administrativas em memória (perdidas ao reiniciar: basta entrar de novo). */
class SessionStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create() {
    const id = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(sha256(id), { expires: Date.now() + this.ttlMs });
    if (this.sessions.size > 200) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
    return id;
  }

  valid(id) {
    if (typeof id !== 'string' || id.length < 20 || id.length > 100) return false;
    const key = sha256(id);
    const s = this.sessions.get(key);
    if (!s) return false;
    if (s.expires <= Date.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  destroy(id) {
    if (typeof id === 'string') this.sessions.delete(sha256(id));
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

module.exports = {
  sha256,
  safeEqualHex,
  safeEqualText,
  newId,
  newToken,
  newCode,
  formatCode,
  credentialHash,
  tokenHash,
  codeHash,
  RateLimiter,
  SessionStore,
  parseCookies,
  CODE_LENGTH,
};
