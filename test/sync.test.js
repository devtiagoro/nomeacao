'use strict';

// Fluxo completo de uma reunião usando o public/js/db.js real, com o SDK do Firebase trocado
// por um banco em memória (test/fake-firebase.mjs). Verifica que administração, apresentação
// e celulares enxergam o mesmo estado em tempo real e que o histórico é preservado.
// As regras de segurança NÃO são aplicadas aqui: veja test/rules (emulador oficial).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');

const FAKE = pathToFileURL(path.join(__dirname, 'fake-firebase.mjs')).href;
const CONFIG = `data:text/javascript,${encodeURIComponent("export const firebaseConfig = { apiKey: 'teste', databaseURL: 'https://teste' }; export const emulator = null;")}`;

let db;
let D;
let fake;

test.before(async () => {
  registerHooks({
    resolve(specifier, context, next) {
      if (/^https:\/\/www\.gstatic\.com\/firebasejs\//.test(specifier)) return { url: FAKE, shortCircuit: true };
      const r = next(specifier, context);
      if (r.url.endsWith('/public/js/firebase-config.js')) return { url: CONFIG, shortCircuit: true };
      return r;
    },
  });
  const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;
  [db, D, fake] = await Promise.all([import(js('db.js')), import(js('domain.js')), import(FAKE)]);
});

const tick = () => new Promise((r) => setImmediate(r));

/** Tela pública (apresentação ou celular): segue a reunião em andamento, como as páginas fazem. */
async function publicScreen() {
  const s = { meetingId: null, state: null, stop: null };
  await db.watchCurrent(async (id) => {
    s.stop?.();
    s.meetingId = id;
    s.state = null;
    if (id) s.stop = await db.watchMeeting(id, {}, (st) => (s.state = st));
  });
  return s;
}

const names = (o) => o.candidates.map((c) => c.name);
const idOf = (o, name) => o.candidates.find((c) => c.name === name).id;
const votesOf = (r) => Object.fromEntries(r.candidates.map((c) => [c.name, c.votes]));

async function vote(screen, selectedNames) {
  const o = screen.state.currentOffice;
  const selected = selectedNames.map((n) => (n === 'abstain' ? n : idOf(o, n)));
  await db.castBallot(screen.state.id, o.id, D.ballotChoices(o, selected), D.newRequestId());
}

test('reunião completa: escolha única, múltipla escolha, histórico e próxima reunião', async () => {
  fake.reset();
  const tv = await publicScreen();
  const phone = await publicScreen();
  assert.equal(phone.meetingId, null, 'sem reunião em andamento');

  // Reunião criada: as telas abertas passam a segui-la sozinhas.
  const mid = await db.createMeeting({ name: 'Assembleia', expectedParticipants: 30 });
  await tick();
  assert.equal(tv.meetingId, mid);
  assert.equal(phone.meetingId, mid);
  const admin = { state: null };
  await db.watchMeeting(mid, { admin: true }, (s) => (admin.state = s));

  // ---- Cargo 1: escolha única ----
  const o1 = await db.createOffice(mid, { title: 'Presidente', voteType: 'single' });
  for (const n of ['Ana', 'Bruno', 'Carla']) await db.addCandidate(mid, o1, n);
  assert.equal(admin.state.currentOffice.status, 'draft');
  assert.equal(phone.state.currentOffice, null, 'em preparação: ainda não aparece');
  await assert.rejects(db.addCandidate(mid, o1, 'ana'), /já está na lista/);

  await db.presentOffice(mid, o1);
  assert.equal(tv.state.currentOffice.title, 'Presidente');
  assert.deepEqual(names(phone.state.currentOffice), ['Ana', 'Bruno', 'Carla']);

  // Nomes alterados antes de abrir: celulares e telão atualizam.
  await db.renameCandidate(mid, o1, idOf(admin.state.currentOffice, 'Carla'), 'Carla M.');
  await db.removeCandidate(mid, o1, idOf(admin.state.currentOffice, 'Bruno'));
  assert.deepEqual(names(phone.state.currentOffice), ['Ana', 'Carla M.']);
  assert.deepEqual(names(tv.state.currentOffice), ['Ana', 'Carla M.']);

  await db.openVoting(mid, o1);
  assert.equal(phone.state.currentOffice.status, 'voting_open');
  await assert.rejects(db.addCandidate(mid, o1, 'Davi'), /não pode mudar/);
  await assert.rejects(db.createOffice(mid, { title: 'Outro', voteType: 'single' }), /Encerre o cargo/);

  await vote(phone, ['Ana']);
  await vote(phone, ['Ana']); // outro voto intencional do mesmo aparelho
  await vote(phone, ['Carla M.']);
  await vote(phone, []); // abstenção
  assert.equal(tv.state.currentOffice.ballots, 4, 'contagem de votos ao vivo no telão');
  assert.equal(tv.state.currentOffice.result, null, 'resultado parcial oculto por padrão');
  assert.deepEqual(votesOf(admin.state.currentOffice.result), { Ana: 2, 'Carla M.': 1 }, 'administração acompanha a parcial');

  await db.setLiveResults(mid, o1, true);
  assert.deepEqual(votesOf(tv.state.currentOffice.result), { Ana: 2, 'Carla M.': 1 }, 'parcial liberada pelo administrador');

  await db.closeVoting(mid, o1);
  const final1 = phone.state.currentOffice.result;
  assert.equal(phone.state.currentOffice.status, 'closed');
  assert.deepEqual([final1.ballots, final1.abstentions, final1.validBallots], [4, 1, 3]);
  assert.deepEqual(final1.leaders, [idOf(phone.state.currentOffice, 'Ana')]);

  // ---- Cargo 2: múltipla escolha (próximo cargo, sem novo QR Code) ----
  const o2 = await db.createOffice(mid, { title: 'Conselho', voteType: 'multiple', maxChoices: 2 });
  assert.equal(phone.meetingId, mid, 'mesma reunião: o celular não precisa ler o QR Code de novo');
  assert.equal(phone.state.currentOffice, null, 'novo cargo em preparação');
  await db.addCandidate(mid, o2, 'Davi');
  await db.presentOffice(mid, o2);
  await assert.rejects(db.openVoting(mid, o2), /máximo de escolhas \(2\) é maior/);
  await db.addCandidate(mid, o2, 'Eva');
  await db.addCandidate(mid, o2, 'Fábio');
  await db.openVoting(mid, o2);
  assert.equal(phone.state.currentOffice.maxChoices, 2);

  await vote(phone, ['Davi', 'Eva']);
  await vote(phone, ['Davi', 'Fábio']);
  await vote(phone, ['Eva']);
  await vote(phone, ['abstain']);
  assert.throws(() => D.ballotChoices(phone.state.currentOffice, phone.state.currentOffice.candidates.map((c) => c.id)), /no máximo 2/);
  await db.closeVoting(mid, o2);

  const final2 = tv.state.currentOffice.result;
  assert.deepEqual(votesOf(final2), { Davi: 2, Eva: 2, Fábio: 1 });
  assert.deepEqual([final2.ballots, final2.abstentions, final2.totalVotes, final2.voteType], [4, 1, 5, 'multiple']);

  // ---- Histórico: cargos anteriores preservados ----
  const closed = admin.state.offices.filter((o) => o.status === 'closed');
  assert.deepEqual(closed.map((o) => o.title), ['Presidente', 'Conselho']);
  assert.deepEqual(closed[0].result, final1, 'resultado do primeiro cargo não foi sobrescrito');
  assert.ok(closed.every((o) => o.openedAt && o.closedAt && o.createdAt), 'data e horário registrados');

  const doc = await db.exportMeeting(mid);
  assert.deepEqual(Object.values(doc.results).map((r) => [r.title, r.voteType, r.ballots]), [
    ['Presidente', 'single', 4],
    ['Conselho', 'multiple', 4],
  ]);
  const csv = D.resultsCsv(doc.meeting, doc.counts, doc.tallies);
  assert.match(csv, /Presidente;Escolha única/);
  assert.match(csv, /Conselho;Múltipla escolha;2/);

  // ---- Nova reunião: as telas abertas mudam sozinhas; a anterior continua disponível ----
  const mid2 = await db.createMeeting({ name: 'Reunião extraordinária', expectedParticipants: 12 });
  await tick();
  assert.equal(phone.meetingId, mid2);
  assert.equal(tv.state.name, 'Reunião extraordinária');
  assert.equal(phone.state.currentOffice, null);
  assert.equal((await db.listMeetings()).length, 2);
  assert.equal(Object.keys((await db.exportMeeting(mid)).results).length, 2, 'histórico da reunião anterior preservado');

  await db.setCurrentMeeting(mid);
  await tick();
  assert.equal(phone.meetingId, mid, 'retomar reunião anterior');
});
