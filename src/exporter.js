'use strict';

const QRCode = require('qrcode');

/** Célula CSV segura: neutraliza fórmulas (CSV injection) e escapa separadores. */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n) => String(n).replace('.', ',');

const HEADER = [
  'reuniao_id',
  'reuniao',
  'cargo_id',
  'cargo',
  'aberto_em',
  'encerrado_em',
  'tipo',
  'opcao_id',
  'opcao',
  'quantidade',
  'pct_validos',
  'pct_registrados',
];

/** CSV (separador ";" e vírgula decimal, compatível com Excel pt-BR) de cargos encerrados. */
function resultsCsv(meeting, officeIds = null) {
  const rows = [HEADER];
  for (const o of meeting.offices) {
    if (o.status !== 'closed' || (officeIds && !officeIds.includes(o.id))) continue;
    const r = o.result;
    const base = [meeting.id, meeting.name, o.id, o.title, o.openedAt, o.closedAt];
    for (const c of r.candidates) rows.push([...base, 'candidato', c.id, c.name, c.votes, num(c.pctValid), num(c.pctCast)]);
    rows.push([...base, 'abstencao', '', 'Abstenção', r.abstentions, '', num(r.abstentionPctCast)]);
    rows.push([...base, 'total', '', 'Votos registrados', r.castVotes, '', '100']);
    rows.push([...base, 'total', '', 'Votos válidos (sem abstenção)', r.validVotes, '', '']);
    // Pessoas presentes é o número informado pela mesa; não é derivado dos votos.
    rows.push([...base, 'presenca', '', 'Pessoas presentes (informado)', r.presentParticipants ?? r.expectedParticipants, '', '']);
    rows.push([...base, 'resumo', '', r.tie ? 'Empate entre os mais votados' : 'Sem empate', r.leaders.length, '', '']);
    rows.push([...base, 'integridade', '', `sha256:${o.resultHash}`, '', '', '']);
  }
  return '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

function qrSvg(text) {
  return QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

async function qrDataUrl(text) {
  return `data:image/svg+xml;base64,${Buffer.from(await qrSvg(text)).toString('base64')}`;
}

module.exports = { resultsCsv, csvCell, qrSvg, qrDataUrl };
