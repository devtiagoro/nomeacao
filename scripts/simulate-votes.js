'use strict';

// Simula votos concorrentes contra um servidor NOMEIA em execução.
//
// Uso:
//   node scripts/simulate-votes.js --base http://localhost:3000 --secret SEU_SEGREDO --voters 50 --dup 3 [--concurrency 150]
//
// Sem --base, sobe um servidor temporário em memória/disco temporário (não toca em data/).
// Cria uma reunião, emite credenciais, abre um cargo e dispara todos os votos ao mesmo tempo,
// com cada credencial tentando votar --dup vezes. Ao final confere: 1 voto por credencial.
// Atenção: com servidor real, o rate limit por IP (padrão 30 votos/min) recusa parte dos
// envios vindos de uma única máquina; isso aparece como "429" no relatório.

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    secret: { type: 'string' },
    voters: { type: 'string', default: '40' },
    dup: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '150' },
  },
});

const voters = Math.max(1, Math.min(2000, Number(args.voters)));
const dup = Math.max(1, Math.min(20, Number(args.dup)));
const concurrency = Math.max(dup, Math.min(1000, Number(args.concurrency)));

async function main() {
  let base = args.base;
  let secret = args.secret || process.env.ADMIN_SECRET;
  let local = null;
  if (!base) {
    const { createApp } = require('../src/app');
    secret = 'simulacao-local-0123456789';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomeia-sim-'));
    const unlimited = { limit: 1e9, windowMs: 60_000 };
    local = createApp({
      dataDir,
      adminSecret: secret,
      quiet: true,
      rateLimits: { global: unlimited, vote: unlimited, admin: unlimited, credCheck: unlimited },
    });
    await local.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${local.port}`;
    console.log(`Servidor temporário em ${base} (dados em ${dataDir})`);
  }
  if (!secret) throw new Error('Informe --secret ou ADMIN_SECRET.');

  const headers = { 'Content-Type': 'application/json', 'X-Nomeia': '1' };
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers, body: JSON.stringify({ secret }) });
  if (!login.ok) throw new Error(`login falhou: ${login.status}`);
  const admin = { ...headers, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const call = async (method, p, body, h = admin) => {
    const r = await fetch(base + p, { method, headers: h, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const m = (await call('POST', '/api/admin/meetings', { name: `Simulação ${new Date().toLocaleString('pt-BR')}`, expectedParticipants: voters })).body;
  const mp = `/api/admin/meetings/${m.id}`;
  const officeId = (await call('POST', `${mp}/offices`, { title: 'Cargo simulado' })).body.officeId;
  for (const name of ['Alfa', 'Beta', 'Gama']) await call('POST', `${mp}/offices/${officeId}/candidates`, { name });
  const cards = [];
  for (let left = voters; left > 0; left -= 500) {
    cards.push(...(await call('POST', `${mp}/credentials`, { count: Math.min(500, left), labelPrefix: 'Sim' })).body.issued);
  }
  const tokens = cards.map((c) => c.link.split('#t=')[1]);
  const cands = (await call('GET', mp)).body.offices[0].candidates;
  await call('POST', `${mp}/offices/${officeId}/open`);

  const options = [...cands.map((c) => c.id), 'abstain'];
  // Cada credencial dispara suas `dup` tentativas ao mesmo tempo; os grupos rodam em lotes
  // de até `concurrency` requisições (o Windows recusa milhares de conexões no mesmo instante).
  const groups = tokens.map((t, i) => () =>
    Promise.all(
      Array.from({ length: dup }, (_, k) =>
        call('POST', `/api/meetings/${m.id}/votes`, { officeId, choice: options[(i + k) % options.length] }, { ...headers, Authorization: `Bearer ${t}` }),
      ),
    ),
  );
  const perBatch = Math.max(1, Math.floor(concurrency / dup));
  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < groups.length; i += perBatch) {
    for (const g of await Promise.all(groups.slice(i, i + perBatch).map((run) => run()))) results.push(...g);
  }
  const jobs = results;
  const elapsed = Date.now() - t0;
  const byStatus = {};
  for (const r of results) {
    const key = r.status === 201 ? '201 aceito' : `${r.status} ${r.body?.error?.code || ''}`.trim();
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const closed = (await call('POST', `${mp}/offices/${officeId}/close`)).body.offices[0].result;
  const accepted = byStatus['201 aceito'] || 0;
  console.log(`\n${jobs.length} requisições (${voters} credenciais × ${dup} simultâneas, lotes de ~${perBatch * dup}) em ${elapsed} ms`);
  console.table(byStatus);
  console.log('Resultado apurado:');
  console.table(closed.candidates.map((c) => ({ candidato: c.name, votos: c.votes, '% válidos': c.pctValid })));
  console.log(`Abstenções: ${closed.abstentions} · Registrados: ${closed.castVotes} · Sem voto: ${closed.notVotedCredentials}`);

  const ok = closed.castVotes === accepted && accepted <= voters && !Object.keys(byStatus).some((k) => k.startsWith('5'));
  console.log(ok ? '\nOK: nenhum voto duplicado; apuração = votos aceitos.' : '\nFALHA: inconsistência detectada!');
  if (local) await local.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message, err.cause || "");
  process.exit(1);
});
