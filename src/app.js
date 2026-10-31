'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { loadConfig, ensureAdminSecret } = require('./config');
const { Store } = require('./store');
const { Hub } = require('./realtime');
const D = require('./domain');
const S = require('./security');
const H = require('./http');
const { resultsCsv, qrSvg, qrDataUrl } = require('./exporter');

const { HttpError } = D;
const JSON_LIMIT = 16 * 1024;
const IMPORT_LIMIT = 10 * 1024 * 1024;

function makeLogger(quiet) {
  const stamp = () => new Date().toISOString();
  return {
    info: (msg) => !quiet && console.log(`${stamp()} INFO  ${msg}`),
    warn: (msg) => !quiet && console.warn(`${stamp()} WARN  ${msg}`),
    error: (msg) => console.error(`${stamp()} ERROR ${msg}`),
  };
}

function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_\- ]{1,100})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

/**
 * Cria a aplicação (servidor HTTP/HTTPS + WebSocket + store). Não começa a escutar
 * até listen() ser chamado, para facilitar testes com diretórios temporários.
 */
function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const log = overrides.log || makeLogger(cfg.quiet);
  const adminSecret = ensureAdminSecret(cfg, log);
  const store = new Store({ dataDir: cfg.dataDir, backupKeep: cfg.backupKeep, log });
  const sessions = new S.SessionStore(cfg.sessionTtlMs);
  const limiter = new S.RateLimiter(cfg.rateLimits);
  const secureCookie = cfg.production || cfg.tls;
  const cookieName = secureCookie ? '__Host-nomeia_sid' : 'nomeia_sid';

  const server = cfg.tls
    ? https.createServer({ key: fs.readFileSync(cfg.tlsKeyFile), cert: fs.readFileSync(cfg.tlsCertFile) })
    : http.createServer();
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;

  const hub = new Hub({ server, store, cfg, sessions, limiter, cookieName, log });

  // ---------------- Roteador mínimo ----------------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, re, handler, admin: pattern.startsWith('/api/admin/') && !opts.public, ...opts });
  };

  const sessionOf = (req) => S.parseCookies(req.headers.cookie)[cookieName];

  function setSessionCookie(res, value, maxAgeSec) {
    const parts = [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  async function issueCard(base, meetingId, p, token, code) {
    const link = `${base}/votar.html?m=${encodeURIComponent(meetingId)}#t=${token}`;
    return { participantId: p.id, label: p.label, code: S.formatCode(code), link, qr: await qrDataUrl(link) };
  }

  function genCredential(m) {
    for (;;) {
      const token = S.newToken();
      const code = S.newCode();
      const th = S.tokenHash(token);
      const ch = S.codeHash(code);
      const clash = (h) => store.lookupCredential(h) || m.participants.some((p) => p.tokenHash === h || p.codeHash === h);
      if (!clash(th) && !clash(ch)) return { token, code, th, ch };
    }
  }

  /** Resolve a credencial dentro da reunião, comparando hashes em tempo constante. */
  function resolveParticipant(m, raw) {
    const hash = S.credentialHash(raw);
    const ref = store.lookupCredential(hash);
    if (!ref || ref.meetingId !== m.id) return null;
    const p = m.participants.find((x) => x.id === ref.participantId);
    if (!p) return null;
    return S.safeEqualHex(hash, p.tokenHash) || S.safeEqualHex(hash, p.codeHash) ? p : null;
  }

  // ---------------- Público ----------------

  route('GET', '/api/health', () => ({ ok: true }));

  route('GET', '/api/meetings/:id', ({ params }) => D.publicSnapshot(store.require(params.id)));

  route('GET', '/api/meetings/:id/link', ({ params, req }) => {
    store.require(params.id);
    return { publicUrl: `${H.publicBase(req, cfg)}/votar.html?m=${encodeURIComponent(params.id)}` };
  });

  route('GET', '/api/meetings/:id/qr.svg', async ({ params, req, res }) => {
    store.require(params.id);
    const svg = await qrSvg(`${H.publicBase(req, cfg)}/votar.html?m=${encodeURIComponent(params.id)}`);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    res.end(svg);
  });

  route('POST', '/api/credentials/check', async ({ req, ip }) => {
    if (limiter.blocked('credFail', ip) || !limiter.hit('credCheck', ip)) {
      throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde alguns minutos.');
    }
    const raw = bearer(req);
    if (!raw) throw new HttpError(401, 'credential_required', 'Informe a credencial de votação.');
    const ref = store.lookupCredential(S.credentialHash(raw));
    let m = ref && store.get(ref.meetingId);
    let p = m && resolveParticipant(m, raw);
    if (!p) {
      limiter.hit('credFail', ip);
      throw new HttpError(401, 'invalid_credential', 'Credencial não reconhecida.');
    }
    if (!p.firstSeenAt && !p.revoked && m.status === 'active') {
      ({ meeting: m } = await store.mutate(m.id, (draft) => {
        const dp = draft.participants.find((x) => x.id === p.id);
        if (dp && !dp.firstSeenAt) dp.firstSeenAt = D.now();
      }));
      p = m.participants.find((x) => x.id === p.id);
      hub.broadcast(m.id, 'turnout_updated');
    }
    return {
      meetingId: m.id,
      meetingName: m.name,
      participant: { label: p.label, revoked: p.revoked },
      votedOfficeIds: m.offices.filter((o) => o.voterIds.includes(p.id)).map((o) => o.id),
    };
  });

  route('POST', '/api/meetings/:id/votes', async ({ req, params, body, ip }) => {
    if (!limiter.hit('vote', ip)) throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde um momento.');
    const raw = bearer(req);
    if (!raw) throw new HttpError(401, 'credential_required', 'É necessária uma credencial de votação para votar.');
    const officeId = typeof body.officeId === 'string' ? body.officeId : '';
    const choice = typeof body.choice === 'string' ? body.choice : '';
    if (!D.ID_RE.test(officeId) || !(choice === D.ABSTAIN || D.ID_RE.test(choice))) {
      throw new HttpError(400, 'invalid_input', 'Voto inválido.');
    }
    store.require(params.id);
    // Toda a validação acontece dentro da fila serializada da reunião, sobre o estado confirmado.
    await store.mutate(params.id, (m) => {
      const p = resolveParticipant(m, raw);
      if (!p) {
        limiter.hit('credFail', ip);
        throw new HttpError(403, 'invalid_credential', 'Credencial inválida para esta reunião.');
      }
      if (p.revoked) throw new HttpError(403, 'credential_revoked', 'Esta credencial foi revogada.');
      D.assertActive(m);
      const o = D.findOffice(m, officeId);
      if (o.id !== m.currentOfficeId || o.status !== 'voting_open') {
        throw o.status === 'closed'
          ? new HttpError(409, 'voting_closed', 'A votação deste cargo já foi encerrada. Voto não registrado.')
          : new HttpError(409, 'voting_not_open', 'A votação deste cargo não está aberta.');
      }
      if (o.voterIds.includes(p.id)) {
        throw new HttpError(409, 'already_voted', 'Seu voto para este cargo já foi registrado.');
      }
      if (choice === D.ABSTAIN) {
        o.tally.abstain++;
      } else {
        if (!o.candidates.some((c) => c.id === choice)) throw new HttpError(400, 'invalid_choice', 'Opção inválida.');
        o.tally.byCandidate[choice] = (o.tally.byCandidate[choice] || 0) + 1;
      }
      // Posição aleatória: a ordem da lista não revela a ordem dos votos.
      o.voterIds.splice(crypto.randomInt(o.voterIds.length + 1), 0, p.id);
      if (!p.firstSeenAt) p.firstSeenAt = D.now();
    });
    hub.broadcast(params.id, 'vote_accepted');
    return { status: 201, body: { status: 'accepted', officeId, message: 'Voto registrado.' } };
  });

  // ---------------- Sessão administrativa ----------------

  route(
    'POST',
    '/api/admin/login',
    ({ body, res, ip }) => {
      if (!limiter.hit('login', ip)) throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde 15 minutos.');
      if (typeof body.secret !== 'string' || body.secret.length > 512 || !S.safeEqualText(body.secret, adminSecret)) {
        throw new HttpError(401, 'invalid_secret', 'Segredo administrativo incorreto.');
      }
      setSessionCookie(res, sessions.create(), Math.floor(cfg.sessionTtlMs / 1000));
      return { ok: true };
    },
    { public: true },
  );

  route(
    'POST',
    '/api/admin/logout',
    ({ req, res }) => {
      sessions.destroy(sessionOf(req));
      setSessionCookie(res, '', 0);
      return { ok: true };
    },
    { public: true },
  );

  route('GET', '/api/admin/session', ({ req }) => ({ authenticated: sessions.valid(sessionOf(req)) }), { public: true });

  // ---------------- Reuniões ----------------

  route('GET', '/api/admin/meetings', () =>
    store.list().map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      phase: D.phase(m),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      offices: m.offices.length,
      participants: m.participants.length,
    })),
  );

  route('POST', '/api/admin/meetings', async ({ body }) => {
    if (store.list().length >= 1000) throw new HttpError(409, 'limit', 'Limite de reuniões atingido.');
    const m = D.newMeeting(body);
    await store.create(m);
    return { status: 201, body: D.adminSnapshot(store.get(m.id)) };
  });

  route('GET', '/api/admin/meetings/:id', ({ params }) => D.adminSnapshot(store.require(params.id)));

  route('GET', '/api/admin/meetings/:id/links', async ({ params, req }) => {
    store.require(params.id);
    const base = H.publicBase(req, cfg);
    const publicUrl = `${base}/votar.html?m=${encodeURIComponent(params.id)}`;
    return {
      publicUrl,
      presentationUrl: `${base}/apresentacao.html?m=${encodeURIComponent(params.id)}`,
      qr: await qrDataUrl(publicUrl),
    };
  });

  route('PATCH', '/api/admin/meetings/:id', async ({ params, body }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      if (body.name !== undefined) m.name = D.cleanText(body.name, 'name');
      if (body.expectedParticipants !== undefined) {
        m.expectedParticipants = D.cleanInt(body.expectedParticipants, 'expectedParticipants', 1, D.LIMITS.expectedMax);
      }
    });
    hub.broadcast(params.id, 'meeting_updated');
    return D.adminSnapshot(meeting);
  });

  route('POST', '/api/admin/meetings/:id/archive', async ({ params }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      if (m.offices.some((o) => o.status === 'voting_open')) {
        throw new HttpError(409, 'voting_in_progress', 'Encerre a votação em andamento antes de encerrar a reunião.');
      }
      m.status = 'archived';
      m.archivedAt = D.now();
    });
    hub.broadcast(params.id, 'meeting_closed');
    await store.withLock(params.id, () => store.appendLedger(params.id, { type: 'meeting_archived', meetingVersion: meeting.version }));
    await store.backup(params.id, 'archived');
    return D.adminSnapshot(store.get(params.id));
  });

  // ---------------- Credenciais ----------------

  route('POST', '/api/admin/meetings/:id/credentials', async ({ params, body, req }) => {
    const count = D.cleanInt(body.count, 'count', 1, D.LIMITS.credentialsPerRequest);
    const prefix = D.cleanText(body.labelPrefix ?? 'Credencial', 'labelPrefix', { max: D.LIMITS.labelPrefixMax });
    const { result: issued } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      if (m.participants.length + count > D.LIMITS.credentialsPerMeeting) {
        throw new HttpError(409, 'limit', `Limite de ${D.LIMITS.credentialsPerMeeting} credenciais por reunião.`);
      }
      const out = [];
      for (let i = 0; i < count; i++) {
        const { token, code, th, ch } = genCredential(m);
        m.participantSeq++;
        const p = {
          id: S.newId('p'),
          label: `${prefix} ${String(m.participantSeq).padStart(3, '0')}`,
          tokenHash: th,
          codeHash: ch,
          createdAt: D.now(),
          firstSeenAt: null,
          reissuedAt: null,
          revoked: false,
          revokedAt: null,
        };
        m.participants.push(p);
        out.push({ p, token, code });
      }
      return out;
    });
    hub.broadcast(params.id, 'turnout_updated');
    const base = H.publicBase(req, cfg);
    const cards = [];
    for (const { p, token, code } of issued) cards.push(await issueCard(base, params.id, p, token, code));
    return { status: 201, body: { issued: cards } };
  });

  route('POST', '/api/admin/meetings/:id/participants/:pid/reissue', async ({ params, req }) => {
    const { result } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const p = m.participants.find((x) => x.id === params.pid);
      if (!p) throw new HttpError(404, 'participant_not_found', 'Credencial não encontrada.');
      if (p.revoked) throw new HttpError(409, 'credential_revoked', 'Credencial revogada não pode ser reemitida.');
      const { token, code, th, ch } = genCredential(m);
      p.tokenHash = th;
      p.codeHash = ch;
      p.reissuedAt = D.now();
      return { p: { ...p }, token, code };
    });
    hub.broadcast(params.id, 'turnout_updated');
    return { issued: [await issueCard(H.publicBase(req, cfg), params.id, result.p, result.token, result.code)] };
  });

  route('POST', '/api/admin/meetings/:id/participants/:pid/revoke', async ({ params }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const p = m.participants.find((x) => x.id === params.pid);
      if (!p) throw new HttpError(404, 'participant_not_found', 'Credencial não encontrada.');
      if (!p.revoked) {
        p.revoked = true;
        p.revokedAt = D.now();
      }
    });
    hub.broadcast(params.id, 'turnout_updated');
    return D.adminSnapshot(meeting);
  });

  // ---------------- Cargos e candidatos ----------------

  function startOffice(m, o) {
    const act = D.activeOffice(m);
    if (act && act.id !== o.id) {
      throw new HttpError(409, 'office_in_progress', `O cargo "${act.title}" ainda está em andamento.`);
    }
    if (o.status !== 'draft') throw new HttpError(409, 'invalid_state', 'Este cargo já foi iniciado.');
    const hadPrevious = Boolean(m.currentOfficeId);
    o.status = 'discussing';
    o.startedAt = D.now();
    o.updatedAt = o.startedAt;
    m.currentOfficeId = o.id;
    return hadPrevious ? 'next_office' : 'office_updated';
  }

  route('POST', '/api/admin/meetings/:id/offices', async ({ params, body }) => {
    const { meeting, result } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      if (m.offices.length >= D.LIMITS.officesPerMeeting) throw new HttpError(409, 'limit', 'Limite de cargos atingido.');
      const o = D.newOffice(body);
      m.offices.push(o);
      const event = body.start === false ? 'office_updated' : startOffice(m, o);
      return { officeId: o.id, event };
    });
    hub.broadcast(params.id, result.event);
    return { status: 201, body: { officeId: result.officeId, meeting: D.adminSnapshot(meeting) } };
  });

  route('PATCH', '/api/admin/meetings/:id/offices/:oid', async ({ params, body }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      if (o.status === 'closed') throw new HttpError(409, 'office_closed', 'Cargo encerrado: resultados são imutáveis.');
      if (body.title !== undefined || body.description !== undefined) D.assertEditable(o);
      if (body.title !== undefined) o.title = D.cleanText(body.title, 'title');
      if (body.description !== undefined) {
        o.description = D.cleanText(body.description, 'description', { optional: true, max: D.LIMITS.descriptionMax });
      }
      if (body.resultsMode !== undefined) o.resultsMode = D.cleanResultsMode(body.resultsMode);
      o.updatedAt = D.now();
    });
    hub.broadcast(params.id, 'office_updated');
    return D.adminSnapshot(meeting);
  });

  route('POST', '/api/admin/meetings/:id/offices/:oid/start', async ({ params }) => {
    const { meeting, result } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      return startOffice(m, D.findOffice(m, params.oid));
    });
    hub.broadcast(params.id, result);
    return D.adminSnapshot(meeting);
  });

  const sameName = (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }) === 0;

  route('POST', '/api/admin/meetings/:id/offices/:oid/candidates', async ({ params, body }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      D.assertEditable(o);
      if (o.candidates.length >= D.LIMITS.candidatesPerOffice) throw new HttpError(409, 'limit', 'Limite de candidatos atingido.');
      const c = D.newCandidate(body.name);
      if (o.candidates.some((x) => sameName(x.name, c.name))) {
        throw new HttpError(409, 'duplicate_candidate', 'Este nome já está na lista deste cargo.');
      }
      o.candidates.push(c);
      o.updatedAt = D.now();
    });
    hub.broadcast(params.id, 'candidates_updated');
    return { status: 201, body: D.adminSnapshot(meeting) };
  });

  route('PATCH', '/api/admin/meetings/:id/offices/:oid/candidates/:cid', async ({ params, body }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      D.assertEditable(o);
      const c = o.candidates.find((x) => x.id === params.cid);
      if (!c) throw new HttpError(404, 'candidate_not_found', 'Candidato não encontrado.');
      const name = D.cleanText(body.name, 'name');
      if (o.candidates.some((x) => x.id !== c.id && sameName(x.name, name))) {
        throw new HttpError(409, 'duplicate_candidate', 'Este nome já está na lista deste cargo.');
      }
      c.name = name;
      c.updatedAt = D.now();
      o.updatedAt = c.updatedAt;
    });
    hub.broadcast(params.id, 'candidates_updated');
    return D.adminSnapshot(meeting);
  });

  route('DELETE', '/api/admin/meetings/:id/offices/:oid/candidates/:cid', async ({ params }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      D.assertEditable(o);
      const i = o.candidates.findIndex((x) => x.id === params.cid);
      if (i < 0) throw new HttpError(404, 'candidate_not_found', 'Candidato não encontrado.');
      o.candidates.splice(i, 1);
      o.updatedAt = D.now();
    });
    hub.broadcast(params.id, 'candidates_updated');
    return D.adminSnapshot(meeting);
  });

  route('POST', '/api/admin/meetings/:id/offices/:oid/open', async ({ params }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      if (o.status !== 'discussing') {
        throw new HttpError(409, 'invalid_state', 'Só é possível abrir a votação de um cargo em discussão.');
      }
      if (!o.candidates.length) throw new HttpError(409, 'no_candidates', 'Adicione ao menos um nome antes de abrir a votação.');
      o.status = 'voting_open';
      o.openedAt = D.now();
      o.updatedAt = o.openedAt;
      o.tally = { abstain: 0, byCandidate: Object.fromEntries(o.candidates.map((c) => [c.id, 0])) };
    });
    hub.broadcast(params.id, 'vote_opened');
    return D.adminSnapshot(meeting);
  });

  route('POST', '/api/admin/meetings/:id/offices/:oid/close', async ({ params }) => {
    const { meeting, result: o } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      if (o.status === 'closed') throw new HttpError(409, 'office_closed', 'Esta votação já foi encerrada.');
      if (o.status !== 'voting_open') throw new HttpError(409, 'voting_not_open', 'A votação deste cargo não está aberta.');
      o.status = 'closed';
      o.closedAt = D.now();
      o.updatedAt = o.closedAt;
      o.result = D.computeResult(m, o);
      o.resultHash = D.resultHash(m.id, o);
      if (o.resultsMode !== 'on_publish') {
        o.resultsPublished = true;
        o.publishedAt = o.closedAt;
      }
      return { id: o.id, title: o.title, resultHash: o.resultHash, result: o.result, published: o.resultsPublished };
    });
    hub.broadcast(params.id, 'vote_closed');
    if (o.published) hub.broadcast(params.id, 'results_published');
    await store.withLock(params.id, () =>
      store.appendLedger(params.id, { type: 'office_closed', officeId: o.id, title: o.title, resultHash: o.resultHash, result: o.result }),
    );
    await store.backup(params.id, 'office-closed');
    return D.adminSnapshot(store.get(params.id) || meeting);
  });

  route('POST', '/api/admin/meetings/:id/offices/:oid/publish', async ({ params }) => {
    const { meeting } = await store.mutate(params.id, (m) => {
      D.assertActive(m);
      const o = D.findOffice(m, params.oid);
      if (o.status !== 'closed') throw new HttpError(409, 'invalid_state', 'Encerre a votação antes de publicar.');
      if (o.resultsPublished) throw new HttpError(409, 'already_published', 'Resultados já publicados.');
      o.resultsPublished = true;
      o.publishedAt = D.now();
    });
    hub.broadcast(params.id, 'results_published');
    await store.withLock(params.id, () => store.appendLedger(params.id, { type: 'results_published', officeId: params.oid }));
    return D.adminSnapshot(meeting);
  });

  // ---------------- Backup, exportação, importação ----------------

  route('POST', '/api/admin/meetings/:id/backup', async ({ params }) => {
    store.require(params.id);
    return { status: 201, body: { file: await store.backup(params.id, 'manual') } };
  });

  route('GET', '/api/admin/meetings/:id/backups', async ({ params }) => {
    store.require(params.id);
    return { backups: await store.listBackups(params.id) };
  });

  const fileName = (m, ext) => `nomeia-${m.id}-${new Date().toISOString().slice(0, 10)}.${ext}`;

  route('GET', '/api/admin/meetings/:id/export.json', async ({ params, res }) => {
    const m = store.require(params.id);
    const doc = await store.exportDoc(m.id);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName(m, 'json')}"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(doc, null, 2));
  });

  function sendCsv(res, m, officeIds) {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName(m, 'csv')}"`,
      'Cache-Control': 'no-store',
    });
    res.end(resultsCsv(m, officeIds));
  }

  route('GET', '/api/admin/meetings/:id/export.csv', ({ params, res }) => sendCsv(res, store.require(params.id)));

  route('GET', '/api/admin/meetings/:id/offices/:oid/export.csv', ({ params, res }) => {
    const m = store.require(params.id);
    const o = D.findOffice(m, params.oid);
    if (o.status !== 'closed') throw new HttpError(409, 'invalid_state', 'Somente cargos encerrados podem ser exportados.');
    sendCsv(res, m, [o.id]);
  });

  route(
    'POST',
    '/api/admin/import',
    async ({ body }) => {
      const m = await store.importDoc(body);
      await store.backup(m.id, 'imported');
      return { status: 201, body: { id: m.id, name: m.name } };
    },
    { bodyLimit: IMPORT_LIMIT },
  );

  // ---------------- Despacho ----------------

  async function handleApi(req, res, url, ip) {
    const candidates = routes.filter((r) => r.re.test(url.pathname));
    if (!candidates.length) return H.notFound(res);
    const r = candidates.find((x) => x.method === req.method);
    if (!r) return H.sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Método não permitido.' } });

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) {
      // Proteção CSRF: cabeçalho customizado (exige preflight CORS, que nunca autorizamos),
      // origem conferida e bloqueio de requisições cross-site.
      const origin = req.headers.origin;
      if (req.headers['x-nomeia'] !== '1') throw new HttpError(403, 'forbidden', 'Requisição recusada.');
      if (origin && !H.isAllowedOrigin(origin, req, cfg)) throw new HttpError(403, 'forbidden_origin', 'Origem não permitida.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'forbidden_origin', 'Origem não permitida.');
    }
    if (r.admin) {
      if (!sessions.valid(sessionOf(req))) throw new HttpError(401, 'unauthorized', 'Acesso administrativo necessário.');
      if (!limiter.hit('admin', ip)) throw new HttpError(429, 'rate_limited', 'Muitas requisições.');
    }
    const params = {};
    for (const [k, v] of Object.entries(r.re.exec(url.pathname).groups || {})) {
      let dv;
      try {
        dv = decodeURIComponent(v);
      } catch {
        throw new HttpError(400, 'invalid_input', 'Parâmetro inválido.');
      }
      if (!D.ID_RE.test(dv)) throw new HttpError(404, 'not_found', 'Não encontrado.');
      params[k] = dv;
    }
    const body = mutating ? await H.readJson(req, r.bodyLimit || JSON_LIMIT) : {};
    const out = await r.handler({ req, res, url, params, body, ip });
    if (res.headersSent) return;
    if (out && typeof out.status === 'number' && 'body' in out) return H.sendJson(res, out.status, out.body);
    return H.sendJson(res, 200, out ?? { ok: true });
  }

  server.on('request', async (req, res) => {
    const started = Date.now();
    const ip = H.clientIp(req, cfg);
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    res.on('finish', () => {
      // Log sem query string, cabeçalhos ou corpo: tokens nunca aparecem aqui.
      if (url.pathname.startsWith('/api/')) log.info(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    H.securityHeaders(req, res, cfg);
    try {
      if (!limiter.hit('global', ip)) throw new HttpError(429, 'rate_limited', 'Muitas requisições.');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, ip);
      const meetingParam = url.searchParams.get('m');
      return await H.serveStatic(req, res, cfg, url.pathname, async (rel, buf) => {
        if (rel !== '/manifest.webmanifest' || !meetingParam || !D.ID_RE.test(meetingParam) || !store.get(meetingParam)) {
          return buf;
        }
        // Manifesto vinculado à reunião: a PWA instalada abre direto na tela de votação dela.
        const manifest = JSON.parse(buf.toString('utf8'));
        manifest.start_url = `/votar.html?m=${meetingParam}`;
        return Buffer.from(JSON.stringify(manifest));
      });
    } catch (err) {
      if (!res.headersSent) H.sendError(res, err, log);
      else res.destroy();
    }
  });

  let listening = false;
  const app = {
    cfg,
    store,
    hub,
    server,
    sessions,
    limiter,
    log,
    cookieName,
    get port() {
      return server.address()?.port;
    },
    async listen(port = cfg.port, host = cfg.host) {
      await store.init();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // Backlog maior: absorve a rajada de conexões quando todos votam ao abrir a votação.
        server.listen({ port, host, backlog: 4096 }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      listening = true;
      return app;
    },
    async close() {
      hub.close();
      limiter.stop();
      await store.drain();
      if (listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
        listening = false;
      }
    },
  };
  return app;
}

module.exports = { createApp };
