'use strict';

// Testes das regras de segurança do Firebase Realtime Database contra o EMULADOR oficial.
// Executar com: npm run test:rules   (requer Java 11+ no PATH ou em JAVA_HOME)

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/database');

const { increment, TIMESTAMP } = firebase.database.ServerValue;
const PROJECT = 'demo-nomeia';
const M = 'm_TESTmeeting1';
const O = 'o_TESToffice01';
const O2 = 'o_TESToffice02';
const C1 = 'c_TESTcandid01';
const C2 = 'c_TESTcandid02';
const NOW = 1_760_000_000_000;

let env;

function office(id, status, extra = {}) {
  return {
    id,
    title: 'Presidente',
    description: '',
    status,
    resultsMode: 'on_publish',
    resultsPublished: false,
    createdAt: NOW,
    updatedAt: NOW,
    candidates: {
      [C1]: { id: C1, name: 'Ana', order: 0, createdAt: NOW },
      [C2]: { id: C2, name: 'Bruno', order: 1, createdAt: NOW },
    },
    ...extra,
  };
}

function meeting(officeStatus = 'voting_open', extra = {}) {
  return {
    id: M,
    name: 'Assembleia',
    status: 'active',
    expectedParticipants: 10,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 3,
    currentOfficeId: O,
    offices: { [O]: office(O, officeStatus) },
    ...extra,
  };
}

/** Estado inicial gravado sem regras (como o console do Firebase faria). */
async function seed(data) {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref().set({ admins: { admin1: true }, ...data });
  });
}

const publicDb = () => env.unauthenticatedContext().database();
const adminDb = () => env.authenticatedContext('admin1').database();
const strangerDb = () => env.authenticatedContext('qualquer-pessoa').database();
const rid = () => require('node:crypto').randomBytes(16).toString('hex');

/** O voto exatamente como o navegador envia: uma atualização atômica em três caminhos. */
function voteUpdate(choice, requestId = rid(), oid = O) {
  return {
    [`receipts/${M}/${oid}/${requestId}`]: TIMESTAMP,
    [`tallies/${M}/${oid}/${choice}`]: increment(1),
    [`counts/${M}/${oid}`]: increment(1),
  };
}

async function readAsRules(p) {
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => {
    v = (await ctx.database().ref(p).once('value')).val();
  });
  return v;
}

test.before(async () => {
  const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    database: { host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8') },
  });
});

test.after(() => env?.cleanup());

test('participante (sem login) lê a reunião mas não altera cargos, candidatos nem estado', async () => {
  await seed({ meetings: { [M]: meeting('discussing') } });
  const db = publicDb();
  await assertSucceeds(db.ref(`meetings/${M}`).once('value'));
  await assertSucceeds(db.ref('meetings').once('value'));
  await assertFails(db.ref(`meetings/${M}/name`).set('Hackeada'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/status`).set('voting_open'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/${C1}/name`).set('Outro'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/${C2}`).remove());
  await assertFails(db.ref(`meetings/m_NEWmeeting01`).set({ ...meeting(), id: 'm_NEWmeeting01' }));
  await assertFails(db.ref(`meetings/${M}`).remove());
  // Usuário autenticado que não está em /admins também não altera nada.
  await assertFails(strangerDb().ref(`meetings/${M}/name`).set('Hackeada'));
  assert.equal(await readAsRules(`meetings/${M}/name`), 'Assembleia');
});

test('somente administradores cadastrados em /admins gravam; /admins é imutável pelo app', async () => {
  await seed({});
  const db = adminDb();
  await assertSucceeds(db.ref(`meetings/${M}`).set(meeting('discussing')));
  await assertFails(db.ref(`meetings/m_bad`).set({ ...meeting(), id: 'm_bad' }), 'id inválido');
  await assertFails(db.ref(`meetings/${M}/expectedParticipants`).set(0));
  await assertFails(db.ref(`meetings/${M}/extra`).set('x'), 'campos desconhecidos recusados');
  await assertFails(db.ref(`meetings/${M}`).remove(), 'histórico não pode ser apagado');
  await assertFails(db.ref('admins/admin1').set(false));
  await assertFails(strangerDb().ref('admins/qualquer-pessoa').set(true), 'ninguém se promove a admin');
  await assertSucceeds(db.ref('admins/admin1').once('value'));
  await assertFails(strangerDb().ref('admins/admin1').once('value'));
});

test('candidatos: editáveis na discussão; bloqueados com votação aberta ou encerrada', async () => {
  await seed({ meetings: { [M]: meeting('discussing') } });
  const db = adminDb();
  const C3 = 'c_TESTcandid03';
  await assertSucceeds(db.ref(`meetings/${M}/offices/${O}/candidates/${C3}`).set({ id: C3, name: 'Carla', order: 2, createdAt: NOW }));
  await assertSucceeds(db.ref(`meetings/${M}/offices/${O}/candidates/${C3}/name`).set('Carla M.'));
  await assertSucceeds(db.ref(`meetings/${M}/offices/${O}/status`).set('voting_open'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/${C3}/name`).set('Outra'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/c_TESTcandid04`).set({ id: 'c_TESTcandid04', name: 'D', order: 3 }));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/title`).set('Outro cargo'));
});

test('transições de estado do cargo só avançam (discussão → aberta → encerrada)', async () => {
  await seed({ meetings: { [M]: meeting('discussing') } });
  const db = adminDb();
  const st = db.ref(`meetings/${M}/offices/${O}/status`);
  await assertFails(st.set('closed'), 'não pula a votação');
  await assertSucceeds(st.set('voting_open'));
  await assertFails(st.set('discussing'));
  await assertSucceeds(st.set('closed'));
  await assertFails(st.set('voting_open'), 'cargo encerrado não reabre');
  await assertFails(db.ref(`meetings/${M}/offices/${O}/resultsMode`).set('live'), 'modo congelado após encerrar');
  await assertSucceeds(db.ref(`meetings/${M}/offices/${O}/resultsPublished`).set(true));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/resultsPublished`).set(false), 'publicação não volta atrás');
});

test('voto público: aceito com votação aberta, inclusive repetido de propósito pelo mesmo participante', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') } });
  const db = publicDb();
  for (let i = 0; i < 3; i++) await assertSucceeds(db.ref().update(voteUpdate(C1)));
  await assertSucceeds(db.ref().update(voteUpdate('abstain')));
  await assertSucceeds(db.ref().update(voteUpdate(C2)));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 3, abstain: 1, [C2]: 1 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 5);
});

test('votos simultâneos são contados atomicamente', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') } });
  await Promise.all(Array.from({ length: 40 }, (_, i) => assertSucceeds(publicDb().ref().update(voteUpdate(i % 2 ? C1 : C2)))));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 20, [C2]: 20 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 40);
});

test('retransmissão da mesma confirmação é recusada por inteiro (não conta duas vezes)', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') } });
  const id = rid();
  await assertSucceeds(publicDb().ref().update(voteUpdate(C1, id)));
  await assertFails(publicDb().ref().update(voteUpdate(C1, id)));
  await assertFails(publicDb().ref().update(voteUpdate(C2, id)));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 1 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 1);
});

test('voto recusado fora da votação aberta, em cargo errado, opção inválida ou reunião encerrada', async () => {
  await seed({ meetings: { [M]: meeting('discussing') } });
  await assertFails(publicDb().ref().update(voteUpdate(C1)), 'em discussão');

  await seed({ meetings: { [M]: meeting('closed') } });
  await assertFails(publicDb().ref().update(voteUpdate(C1)), 'encerrada');

  await seed({ meetings: { [M]: meeting('voting_open') } });
  await assertFails(publicDb().ref().update(voteUpdate('c_NAOEXISTE001')), 'candidato inexistente');
  await assertFails(publicDb().ref().update(voteUpdate(C1, rid(), O2)), 'cargo que não é o atual');
  await assertFails(publicDb().ref().update(voteUpdate(C1, 'curto')), 'requestId inválido');

  await seed({ meetings: { [M]: meeting('voting_open', { status: 'archived', archivedAt: NOW }) } });
  await assertFails(publicDb().ref().update(voteUpdate(C1)), 'reunião encerrada');
  assert.equal(await readAsRules(`tallies/${M}`), null);
});

test('contadores só aceitam +1: não é possível definir, somar 2, subtrair ou apagar', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') }, tallies: { [M]: { [O]: { [C1]: 5 } } }, counts: { [M]: { [O]: 5 } } });
  const db = publicDb();
  await assertFails(db.ref(`tallies/${M}/${O}/${C1}`).set(1000));
  await assertFails(db.ref(`tallies/${M}/${O}/${C1}`).set(increment(2)));
  await assertFails(db.ref(`tallies/${M}/${O}/${C1}`).set(increment(-1)));
  await assertFails(db.ref(`tallies/${M}/${O}/${C1}`).remove());
  await assertFails(db.ref(`counts/${M}/${O}`).set(0));
  await assertFails(db.ref(`receipts/${M}/${O}/${rid()}`).set(123), 'recibo exige horário do servidor');
  // O administrador também não altera a apuração.
  await assertFails(adminDb().ref(`tallies/${M}/${O}/${C1}`).set(0));
  assert.equal(await readAsRules(`tallies/${M}/${O}/${C1}`), 5);
});

test('apuração por candidato oculta do público até publicar; total de votos é público', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') }, tallies: { [M]: { [O]: { [C1]: 2 } } }, counts: { [M]: { [O]: 2 } } });
  await assertFails(publicDb().ref(`tallies/${M}/${O}`).once('value'));
  await assertFails(publicDb().ref(`receipts/${M}/${O}`).once('value'), 'recibos nunca são legíveis');
  await assertSucceeds(publicDb().ref(`counts/${M}/${O}`).once('value'));
  await assertSucceeds(adminDb().ref(`tallies/${M}`).once('value'));

  // Modo ao vivo: parcial liberada durante a votação.
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`meetings/${M}/offices/${O}/resultsMode`).set('live'));
  await assertSucceeds(publicDb().ref(`tallies/${M}/${O}`).once('value'));
});

test('resultado selado: gravado uma única vez pela mesa, só com o cargo encerrado, legível após publicar', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') } });
  const sealed = { result: { castVotes: 1 }, resultHash: 'a'.repeat(64), hashVersion: 3 };
  await assertFails(adminDb().ref(`results/${M}/${O}`).set(sealed), 'cargo ainda aberto');

  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`meetings/${M}/offices/${O}/status`).set('closed'));
  await assertFails(publicDb().ref(`results/${M}/${O}`).set(sealed), 'participante não grava resultado');
  await assertFails(adminDb().ref(`results/${M}/${O}`).set({ ...sealed, resultHash: 'xyz' }), 'selo inválido');
  await assertSucceeds(adminDb().ref(`results/${M}/${O}`).set(sealed));
  await assertFails(adminDb().ref(`results/${M}/${O}`).set({ ...sealed, result: { castVotes: 99 } }), 'imutável');
  await assertFails(adminDb().ref(`results/${M}/${O}`).remove(), 'não pode ser apagado');
  await assertFails(adminDb().ref(`results/${M}/${O}/result/castVotes`).set(99));

  await assertFails(publicDb().ref(`results/${M}/${O}`).once('value'), 'oculto antes de publicar');
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`meetings/${M}/offices/${O}/resultsPublished`).set(true));
  await assertSucceeds(publicDb().ref(`results/${M}/${O}`).once('value'));
});

test('reunião encerrada é somente leitura; registro (log) é só de inclusão', async () => {
  await seed({ meetings: { [M]: meeting('closed', { status: 'archived', archivedAt: NOW }) } });
  await assertFails(adminDb().ref(`meetings/${M}/name`).set('Outra'));
  await assertFails(adminDb().ref(`meetings/${M}/status`).set('active'));
  await assertSucceeds(publicDb().ref(`meetings/${M}`).once('value'));

  const entry = adminDb().ref(`log/${M}/e1`);
  await assertSucceeds(entry.set({ type: 'office_closed', at: TIMESTAMP }));
  await assertFails(entry.set({ type: 'outro', at: TIMESTAMP }));
  await assertFails(entry.remove());
  await assertFails(publicDb().ref(`log/${M}`).once('value'));
  await assertFails(publicDb().ref(`log/${M}/e2`).set({ type: 'x', at: TIMESTAMP }));
});
