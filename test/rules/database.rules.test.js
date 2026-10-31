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
const C3 = 'c_TESTcandid03';
const NOW = 1_760_000_000_000;

let env;

function office(id, status, extra = {}) {
  return {
    id,
    title: 'Presidente',
    voteType: 'single',
    maxChoices: 1,
    status,
    liveResults: false,
    createdAt: NOW,
    candidates: {
      [C1]: { id: C1, name: 'Ana', order: 0 },
      [C2]: { id: C2, name: 'Bruno', order: 1 },
      [C3]: { id: C3, name: 'Carla', order: 2 },
    },
    ...extra,
  };
}

function meeting(officeStatus = 'voting_open', officeExtra = {}) {
  return {
    id: M,
    name: 'Assembleia',
    expectedParticipants: 10,
    createdAt: NOW,
    currentOfficeId: O,
    offices: { [O]: office(O, officeStatus, officeExtra) },
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

/** A cédula exatamente como o navegador envia: uma atualização atômica. */
function ballot(choices, requestId = rid(), oid = O) {
  const upd = { [`receipts/${M}/${oid}/${requestId}`]: TIMESTAMP, [`counts/${M}/${oid}`]: increment(1) };
  for (const c of [].concat(choices)) upd[`tallies/${M}/${oid}/${c}`] = increment(1);
  return upd;
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

test('participante (sem login) lê reunião e reunião atual, mas não altera nada', async () => {
  await seed({ meetings: { [M]: meeting('discussing') }, current: M });
  const db = publicDb();
  await assertSucceeds(db.ref(`meetings/${M}`).once('value'));
  await assertSucceeds(db.ref('current').once('value'));
  await assertFails(db.ref('current').set('m_OUTRAreuniao'));
  await assertFails(db.ref(`meetings/${M}/expectedParticipants`).set(99));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/status`).set('voting_open'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/${C1}/name`).set('Outro'));
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/${C2}`).remove());
  await assertFails(db.ref(`meetings/m_NEWmeeting01`).set({ ...meeting(), id: 'm_NEWmeeting01' }));
  // Usuário autenticado que não está em /admins também não altera nada.
  await assertFails(strangerDb().ref(`meetings/${M}/offices/${O}/status`).set('voting_open'));
  await assertFails(strangerDb().ref('current').set(M));
  assert.equal(await readAsRules(`meetings/${M}/offices/${O}/status`), 'discussing');
});

test('somente administradores em /admins gravam; reuniões não são apagadas; /admins é imutável', async () => {
  await seed({});
  const db = adminDb();
  await assertSucceeds(db.ref().update({ [`meetings/${M}`]: meeting('draft'), current: M }), 'cria reunião e a torna atual');
  await assertFails(db.ref('current').set('m_NAOEXISTE00'), 'atual precisa existir');
  await assertFails(db.ref(`meetings/m_bad`).set({ ...meeting(), id: 'm_bad' }), 'id inválido');
  await assertFails(db.ref(`meetings/${M}`).set(meeting('draft')), 'reunião existente não é sobrescrita');
  await assertSucceeds(db.ref(`meetings/${M}/expectedParticipants`).set(12));
  await assertFails(db.ref(`meetings/${M}/expectedParticipants`).set(0));
  await assertFails(db.ref(`meetings/${M}/name`).set('Outra'), 'nome fixo');
  await assertFails(db.ref(`meetings/${M}/extra`).set('x'), 'campos desconhecidos recusados');
  await assertFails(db.ref(`meetings/${M}`).remove(), 'histórico não pode ser apagado');
  await assertFails(db.ref('admins/admin1').set(false));
  await assertFails(strangerDb().ref('admins/qualquer-pessoa').set(true), 'ninguém se promove a admin');
  await assertSucceeds(db.ref('admins/admin1').once('value'));
  await assertFails(strangerDb().ref('admins/admin1').once('value'));
});

test('cargo: tipo e máximo de escolhas válidos; candidatos editáveis só antes de abrir', async () => {
  await seed({ meetings: { [M]: meeting('draft') } });
  const db = adminDb();
  const base = `meetings/${M}/offices`;
  await assertSucceeds(db.ref(`${base}/${O2}`).set(office(O2, 'draft', { voteType: 'multiple', maxChoices: 2 })));
  await assertFails(db.ref(`${base}/o_TESToffice03`).set(office('o_TESToffice03', 'draft', { voteType: 'single', maxChoices: 3 })), 'única exige 1');
  await assertFails(db.ref(`${base}/o_TESToffice03`).set(office('o_TESToffice03', 'draft', { voteType: 'ranked' })), 'tipo inválido');
  const C4 = 'c_TESTcandid04';
  await assertSucceeds(db.ref(`${base}/${O}/candidates/${C4}`).set({ id: C4, name: 'Davi', order: 3 }));
  await assertSucceeds(db.ref(`${base}/${O}/status`).set('discussing'));
  await assertSucceeds(db.ref(`${base}/${O}/candidates/${C4}/name`).set('Davi M.'));
  await assertSucceeds(db.ref(`${base}/${O}/candidates/${C4}`).remove());
  await assertSucceeds(db.ref(`${base}/${O}/status`).set('voting_open'));
  await assertFails(db.ref(`${base}/${O}/candidates/${C1}/name`).set('Outra'));
  await assertFails(db.ref(`${base}/${O}/candidates/${C4}`).set({ id: C4, name: 'D', order: 3 }));
  await assertFails(db.ref(`${base}/${O}/title`).set('Outro cargo'));
  await assertFails(db.ref(`${base}/${O}/voteType`).set('multiple'));
  await assertSucceeds(db.ref(`${base}/${O}/liveResults`).set(true), 'parcial ao vivo pode ser ligada durante a votação');
});

test('estados só avançam (preparação → apresentado → aberta → encerrada) e cargo encerrado é definitivo', async () => {
  await seed({ meetings: { [M]: meeting('draft') } });
  const db = adminDb();
  const st = db.ref(`meetings/${M}/offices/${O}/status`);
  await assertFails(st.set('voting_open'), 'não abre sem apresentar');
  await assertSucceeds(st.set('discussing'));
  await assertFails(st.set('closed'), 'não pula a votação');
  await assertSucceeds(st.set('voting_open'));
  await assertFails(st.set('discussing'));
  await assertSucceeds(st.set('closed'));
  await assertFails(st.set('voting_open'), 'cargo encerrado não reabre');
  await assertFails(db.ref(`meetings/${M}/offices/${O}/liveResults`).set(true), 'nada muda após encerrar');
  await assertFails(db.ref(`meetings/${M}/offices/${O}/candidates/${C2}`).remove(), 'nomes do cargo encerrado não somem');
  await assertFails(db.ref(`meetings/${M}/offices/${O}`).remove(), 'cargo encerrado não é apagado');
});

test('escolha única: votos aceitos com votação aberta, inclusive repetidos de propósito', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') } });
  const db = publicDb();
  for (let i = 0; i < 3; i++) await assertSucceeds(db.ref().update(ballot(C1)));
  await assertSucceeds(db.ref().update(ballot('abstain')));
  await assertSucceeds(db.ref().update(ballot(C2)));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 3, abstain: 1, [C2]: 1 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 5);
});

test('múltipla escolha: uma cédula com vários nomes conta um voto para cada nome e uma cédula', async () => {
  await seed({ meetings: { [M]: meeting('voting_open', { voteType: 'multiple', maxChoices: 2 }) } });
  const db = publicDb();
  await assertSucceeds(db.ref().update(ballot([C1, C2])));
  await assertSucceeds(db.ref().update(ballot([C1, C3])));
  await assertSucceeds(db.ref().update(ballot([C2])));
  await assertSucceeds(db.ref().update(ballot('abstain')));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 2, [C2]: 2, [C3]: 1, abstain: 1 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 4);
  await assertFails(db.ref().update(ballot([C1, 'c_NAOEXISTE001'])), 'nome inexistente recusa a cédula inteira');
  assert.equal(await readAsRules(`counts/${M}/${O}`), 4);
});

test('cédulas simultâneas são contadas atomicamente', async () => {
  await seed({ meetings: { [M]: meeting('voting_open', { voteType: 'multiple', maxChoices: 2 }) } });
  await Promise.all(Array.from({ length: 40 }, (_, i) => assertSucceeds(publicDb().ref().update(ballot(i % 2 ? [C1, C2] : [C2])))));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 20, [C2]: 40 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 40);
});

test('retransmissão da mesma confirmação é recusada por inteiro (não conta duas vezes)', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') } });
  const id = rid();
  await assertSucceeds(publicDb().ref().update(ballot(C1, id)));
  await assertFails(publicDb().ref().update(ballot(C1, id)));
  await assertFails(publicDb().ref().update(ballot(C2, id)));
  assert.deepEqual(await readAsRules(`tallies/${M}/${O}`), { [C1]: 1 });
  assert.equal(await readAsRules(`counts/${M}/${O}`), 1);
});

test('voto recusado fora da votação aberta, em cargo que não é o atual ou com identificador inválido', async () => {
  for (const status of ['draft', 'discussing', 'closed']) {
    await seed({ meetings: { [M]: meeting(status) } });
    await assertFails(publicDb().ref().update(ballot(C1)), status);
  }
  await seed({ meetings: { [M]: meeting('voting_open') } });
  await assertFails(publicDb().ref().update(ballot('c_NAOEXISTE001')), 'candidato inexistente');
  await assertFails(publicDb().ref().update(ballot(C1, rid(), O2)), 'cargo que não é o atual');
  await assertFails(publicDb().ref().update(ballot(C1, 'curto')), 'identificador inválido');
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
  await assertFails(db.ref(`receipts/${M}/${O}/${rid()}`).set(123), 'marca exige horário do servidor');
  // O administrador também não altera a apuração.
  await assertFails(adminDb().ref(`tallies/${M}/${O}/${C1}`).set(0));
  assert.equal(await readAsRules(`tallies/${M}/${O}/${C1}`), 5);
});

test('votos por candidato: ocultos do público durante a votação, salvo parcial ao vivo; públicos após encerrar', async () => {
  await seed({ meetings: { [M]: meeting('voting_open') }, tallies: { [M]: { [O]: { [C1]: 2 } } }, counts: { [M]: { [O]: 2 } } });
  await assertFails(publicDb().ref(`tallies/${M}/${O}`).once('value'));
  await assertFails(publicDb().ref(`receipts/${M}/${O}`).once('value'), 'marcas nunca são legíveis');
  await assertSucceeds(publicDb().ref(`counts/${M}/${O}`).once('value'), 'total de votos é público');
  await assertSucceeds(adminDb().ref(`tallies/${M}`).once('value'));

  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`meetings/${M}/offices/${O}/liveResults`).set(true));
  await assertSucceeds(publicDb().ref(`tallies/${M}/${O}`).once('value'), 'parcial ao vivo liberada');

  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`meetings/${M}/offices/${O}`).update({ liveResults: false, status: 'closed' }));
  await assertSucceeds(publicDb().ref(`tallies/${M}/${O}`).once('value'), 'resultado final público');
});
