'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/** Carrega um .env simples (CHAVE=valor) sem sobrescrever variáveis já definidas. */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const DEFAULT_RATE_LIMITS = {
  global: { limit: 600, windowMs: 60_000 },
  login: { limit: 8, windowMs: 15 * 60_000 },
  vote: { limit: 30, windowMs: 60_000 },
  credCheck: { limit: 60, windowMs: 60_000 },
  credFail: { limit: 20, windowMs: 10 * 60_000 },
  admin: { limit: 600, windowMs: 60_000 },
  wsConnect: { limit: 60, windowMs: 60_000 },
};

function list(v) {
  return String(v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * Monta a configuração a partir de variáveis de ambiente e overrides (usados nos testes).
 */
function loadConfig(overrides = {}) {
  const env = process.env;
  const production = (overrides.production ?? env.NODE_ENV === 'production') === true;
  const dataDir = path.resolve(ROOT, overrides.dataDir ?? env.DATA_DIR ?? 'data');

  const cfg = {
    root: ROOT,
    production,
    port: Number(overrides.port ?? env.PORT ?? 3000),
    host: overrides.host ?? env.HOST ?? '0.0.0.0',
    dataDir,
    publicDir: path.join(ROOT, 'public'),
    adminSecret: overrides.adminSecret ?? env.ADMIN_SECRET ?? '',
    publicOrigin: String(overrides.publicOrigin ?? env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, ''),
    allowedOrigins: overrides.allowedOrigins ?? list(env.ALLOWED_ORIGINS),
    trustProxy: overrides.trustProxy ?? env.TRUST_PROXY === '1',
    tlsKeyFile: overrides.tlsKeyFile ?? env.TLS_KEY_FILE ?? '',
    tlsCertFile: overrides.tlsCertFile ?? env.TLS_CERT_FILE ?? '',
    backupKeep: Math.max(5, Number(overrides.backupKeep ?? env.BACKUP_KEEP ?? 100)),
    sessionTtlMs: overrides.sessionTtlMs ?? 12 * 60 * 60_000,
    quiet: overrides.quiet ?? false,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...(overrides.rateLimits || {}) },
  };
  cfg.tls = Boolean(cfg.tlsKeyFile && cfg.tlsCertFile);
  return cfg;
}

/**
 * Garante um segredo administrativo. Em produção é obrigatório via ADMIN_SECRET.
 * Em desenvolvimento, gera um e grava em data/admin-secret.txt (nunca no log).
 */
function ensureAdminSecret(cfg, log) {
  if (cfg.adminSecret) {
    if (cfg.adminSecret.length < 16) {
      if (cfg.production) throw new Error('ADMIN_SECRET deve ter pelo menos 16 caracteres.');
      log.warn('ADMIN_SECRET curto (< 16 caracteres). Use um segredo forte em produção.');
    }
    return cfg.adminSecret;
  }
  if (cfg.production) throw new Error('ADMIN_SECRET é obrigatório em produção.');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, 'admin-secret.txt');
  let secret = '';
  if (fs.existsSync(file)) secret = fs.readFileSync(file, 'utf8').trim();
  if (secret.length < 16) {
    secret = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  }
  log.warn(`ADMIN_SECRET não definido: segredo de desenvolvimento gravado em ${file}`);
  cfg.adminSecret = secret;
  return secret;
}

module.exports = { loadConfig, loadDotEnv, ensureAdminSecret, DEFAULT_RATE_LIMITS };
