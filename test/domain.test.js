'use strict';

// Regras de domínio executadas no navegador (public/js/domain.js): cédula, apuração, CSV, exportação.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let D;
test.before(async () => {
  D = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'domain.js')).href);
});

const A = 'c_AAAAAAAAAAAA';
const B = 'c_BBBBBBBBBBBB';
const C = 'c_CCCCCCCCCCCC';

function office(voteType = 'single', maxChoices = 1, extra = {}) {
  return {
    id: 'o_AAAAAAAAAAAA',
    title: 'Presidente',
    voteType,
    maxChoices,
    status: 'closed',
    liveResults: false,
    createdAt: 1,
    openedAt: 1_760_000_000_000,
    closedAt: 1_760_000_060_000,
    candidates: {
      [A]: { id: A, name: 'Ana', order: 0 },
      [B]: { id: B, name: 'Bruno', order: 1 },
      [C]: { id: C, name: 'Carla', order: 2 },
    },
    ...extra,
  };
}

/** Aplica cédulas exatamente como castBallot grava no banco: +1 por nome (ou abstenção) e +1 cédula. */
function apply(o, ballots) {
  const tallies = {};
  let count = 0;
  for (const selected of ballots) {
    for (const k of D.ballotChoices(o, selected)) tallies[k] = (tallies[k] || 0) + 1;
    count++;
  }
  return { tallies, count };
}

test('escolha única: contagem, percentuais, empate, abstenção e candidato com zero votos', () => {
  const o = office();
  const { tallies, count } = apply(o, [[A], [A], [B], [B], []]);
  const r = D.computeResult(o, tallies, count, 8);
  assert.equal(r.voteType, 'single');
  assert.equal(r.maxChoices, 1);
  assert.equal(r.ballots, 5);
  assert.equal(r.abstentions, 1);
  assert.equal(r.validBallots, 4);
  assert.equal(r.present, 8);
  assert.deepEqual(
    r.candidates.map((c) => [c.name, c.votes, c.pct]),
    [
      ['Ana', 2, 50],
      ['Bruno', 2, 50],
      ['Carla', 0, 0],
    ],
  );
  assert.equal(r.tie, true);
  assert.deepEqual(r.leaders, [A, B]);
  assert.equal('elected' in r || 'approved' in r, false, 'nunca declara eleito');
});

test('múltipla escolha: uma cédula conta um voto para cada nome marcado', () => {
  const o = office('multiple', 2);
  const { tallies, count } = apply(o, [[A, B], [A, C], [A], [B, C], ['abstain']]);
  assert.deepEqual(tallies, { [A]: 3, [B]: 2, [C]: 2, abstain: 1 });
  const r = D.computeResult(o, tallies, count, 5);
  assert.equal(r.ballots, 5, 'cinco cédulas');
  assert.equal(r.validBallots, 4);
  assert.equal(r.totalVotes, 7, 'sete votos em nomes');
  assert.deepEqual(
    r.candidates.map((c) => [c.name, c.votes, c.pct]),
    [
      ['Ana', 3, 75],
      ['Bruno', 2, 50],
      ['Carla', 2, 50],
    ],
  );
  assert.ok(r.candidates.reduce((a, c) => a + c.pct, 0) > 100, 'soma dos percentuais pode passar de 100%');
  assert.deepEqual(r.leaders, [A]);
  assert.equal(r.maxChoices, 2);
});

test('cédula: limites da escolha única e da múltipla escolha', () => {
  const single = office();
  assert.deepEqual(D.ballotChoices(single, [A]), [A]);
  assert.deepEqual(D.ballotChoices(single, []), ['abstain'], 'nada marcado = abstenção');
  assert.deepEqual(D.ballotChoices(single, ['abstain']), ['abstain']);
  assert.throws(() => D.ballotChoices(single, [A, B]), /apenas um nome/);

  const multi = office('multiple', 2);
  assert.deepEqual(D.ballotChoices(multi, [A, B]), [A, B]);
  assert.deepEqual(D.ballotChoices(multi, [A, A]), [A], 'nome repetido conta uma vez');
  assert.throws(() => D.ballotChoices(multi, [A, B, C]), /no máximo 2 nomes/);
  assert.throws(() => D.ballotChoices(multi, [A, 'abstain']), /Abstenção não pode ser combinada/);
  assert.throws(() => D.ballotChoices(multi, ['c_REMOVIDO0000']), /lista de nomes mudou/);

  // As telas guardam os candidatos como lista; a validação aceita os dois formatos.
  assert.deepEqual(D.ballotChoices({ ...multi, candidates: [{ id: A }, { id: B }] }, [B]), [B]);
});

test('sem votos: tudo zerado, sem mais votado', () => {
  const r = D.computeResult(office('multiple', 3), null, undefined, 4);
  assert.deepEqual([r.ballots, r.abstentions, r.totalVotes, r.leaders, r.tie], [0, 0, 0, [], false]);
  assert.ok(r.candidates.every((c) => c.votes === 0 && c.pct === 0));
});

test('percentual com dízima', () => {
  const o = office();
  const r = D.computeResult(o, { [A]: 2, [B]: 1 }, 3, 3);
  assert.deepEqual([r.candidates[0].pct, r.candidates[1].pct, r.tie], [66.67, 33.33, false]);
});

function sampleMeeting() {
  const single = office();
  const multi = office('multiple', 2, { id: 'o_BBBBBBBBBBBB', title: 'Conselho', createdAt: 2 });
  const open = office('single', 1, { id: 'o_CCCCCCCCCCCC', title: 'Tesoureiro', status: 'voting_open', createdAt: 3, closedAt: undefined });
  return {
    meeting: {
      id: 'm_AAAAAAAAAAAA',
      name: '=Assembleia; "geral"',
      expectedParticipants: 5,
      createdAt: 1,
      currentOfficeId: open.id,
      offices: { [single.id]: single, [multi.id]: multi, [open.id]: open },
    },
    counts: { [single.id]: 2, [multi.id]: 3, [open.id]: 1 },
    tallies: { [single.id]: { [A]: 1, abstain: 1 }, [multi.id]: { [A]: 2, [B]: 2, [C]: 1, abstain: 1 }, [open.id]: { [B]: 1 } },
  };
}

test('CSV: cargos encerrados com tipo, abstenções, cédulas e presentes; protege contra fórmulas', () => {
  const { meeting, counts, tallies } = sampleMeeting();
  const csv = D.resultsCsv(meeting, counts, tallies);
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /Presidente;Escolha única;1;closed;2025-10-09T08:53:20.000Z;2025-10-09T08:54:20.000Z;candidato;Ana;1;100/);
  assert.match(csv, /Presidente;Escolha única;1;closed;[^;]*;[^;]*;candidato;Bruno;0;0/, 'candidato com zero votos');
  assert.match(csv, /Conselho;Múltipla escolha;2;closed;[^;]*;[^;]*;candidato;Ana;2;100/);
  assert.match(csv, /Conselho;[^\r]*;abstencao;Abstenções;1;/);
  assert.match(csv, /Conselho;[^\r]*;cedulas;Cédulas registradas;3;/);
  assert.match(csv, /presentes;Pessoas presentes \(informado\);5;/);
  assert.doesNotMatch(csv, /Tesoureiro/, 'votação aberta não entra no CSV');
  assert.match(csv, /"'=Assembleia; ""geral"""/, 'fórmula neutralizada e aspas escapadas');
  assert.equal(D.resultsCsv(meeting, counts, tallies, ['o_BBBBBBBBBBBB']).includes('Presidente'), false, 'filtro por cargo');
});

test('exportação JSON: dados brutos + apuração de cada cargo, sem perder cargos anteriores', () => {
  const { meeting, counts, tallies } = sampleMeeting();
  const doc = JSON.parse(JSON.stringify(D.exportDoc({ meeting, counts, tallies })));
  assert.equal(doc.format, 'nomeia-export');
  assert.equal(doc.version, 4);
  assert.deepEqual(doc.meeting, JSON.parse(JSON.stringify(meeting)));
  assert.deepEqual(doc.counts, counts);
  assert.deepEqual(doc.tallies, tallies);
  assert.deepEqual(Object.keys(doc.results), ['o_AAAAAAAAAAAA', 'o_BBBBBBBBBBBB', 'o_CCCCCCCCCCCC']);
  const multi = doc.results.o_BBBBBBBBBBBB;
  assert.deepEqual([multi.title, multi.voteType, multi.maxChoices, multi.ballots, multi.abstentions, multi.totalVotes], ['Conselho', 'multiple', 2, 3, 1, 5]);
  assert.equal(doc.results.o_CCCCCCCCCCCC.status, 'voting_open');
});

test('IDs e identificadores de confirmação aleatórios no formato aceito pelas regras', () => {
  const ids = new Set(Array.from({ length: 200 }, () => D.newId('m')));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^m_[A-Za-z0-9_-]{12}$/);
  assert.match(D.newRequestId(), D.REQUEST_ID_RE);
});

test('validação de texto e números', () => {
  assert.equal(D.cleanText('  Nome\u0000com‮controle ', 'x'), 'Nome com controle');
  assert.throws(() => D.cleanText('', 'Nome'), /Preencha/);
  assert.throws(() => D.cleanText('   ', 'Nome'), /Preencha/);
  assert.throws(() => D.cleanText('x'.repeat(121), 'Nome'), /entre 1 e 120/);
  assert.throws(() => D.cleanInt(0, 'Presentes', 1, 10), /inteiro/);
  assert.equal(D.cleanInt('7', 'Presentes', 1, 10), 7);
  assert.equal(D.sameName('ANA', 'ana'), true);
});

test('cargo ativo: só um cargo não encerrado por vez', () => {
  const { meeting } = sampleMeeting();
  assert.equal(D.activeOffice(meeting).id, 'o_CCCCCCCCCCCC');
  meeting.offices.o_CCCCCCCCCCCC.status = 'closed';
  assert.equal(D.activeOffice(meeting), null);
});
