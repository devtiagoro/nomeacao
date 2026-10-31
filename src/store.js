'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateMeeting, migrateMeeting, HttpError, SCHEMA_VERSION, ID_RE, now } = require('./domain');
const { sha256 } = require('./security');

const EXPORT_FORMAT = 'nomeia-export';
const SKIP = Symbol('skip');

/** Valor de retorno para mutate() que não altera o estado (nada é gravado). */
function skip(value) {
  return { [SKIP]: true, value };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** rename com novas tentativas: no Windows (antivírus/OneDrive) pode falhar transitoriamente. */
async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await sleep(15 * (i + 1));
    }
  }
}

/** Escrita durável: arquivo temporário + fsync + rename atômico (+ fsync do diretório no POSIX). */
async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') {
    try {
      const d = await fsp.open(dir, 'r');
      await d.sync();
      await d.close();
    } catch {
      /* alguns sistemas de arquivos não suportam fsync de diretório */
    }
  }
}

async function appendDurable(file, line) {
  const fh = await fsp.open(file, 'a', 0o600);
  try {
    await fh.appendFile(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Armazena reuniões em data/meetings/<id>.json. Toda alteração passa por mutate(),
 * que é serializada por reunião: lê o estado confirmado, aplica a função em uma cópia,
 * valida, grava de forma durável e só então publica o novo estado em memória.
 */
class Store {
  constructor({ dataDir, backupKeep = 100, log }) {
    this.dataDir = dataDir;
    this.meetingsDir = path.join(dataDir, 'meetings');
    this.backupsDir = path.join(dataDir, 'backups');
    this.ledgerDir = path.join(dataDir, 'ledger');
    this.backupKeep = backupKeep;
    this.log = log;
    this.meetings = new Map();
    this.queues = new Map();
    this.globalQueue = Promise.resolve();
  }

  async init() {
    for (const d of [this.meetingsDir, this.backupsDir, this.ledgerDir]) await fsp.mkdir(d, { recursive: true });
    const files = await fsp.readdir(this.meetingsDir);
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        // Escrita interrompida: nunca foi confirmada ao cliente, descartamos.
        await fsp.rm(path.join(this.meetingsDir, f), { force: true });
        continue;
      }
      const m = f.match(/^(m_[A-Za-z0-9_-]{12})\.json$/);
      if (m) await this._load(m[1]);
    }
    // Reunião cujo arquivo principal sumiu mas tem backups.
    for (const id of await fsp.readdir(this.backupsDir).catch(() => [])) {
      if (ID_RE.test(id) && !this.meetings.has(id)) await this._load(id);
    }
  }

  async _load(id) {
    const file = path.join(this.meetingsDir, `${id}.json`);
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const m = validateMeeting(migrateMeeting(raw));
      if (m.id !== id) throw new Error('id divergente');
      if (raw.schemaVersion !== m.schemaVersion) {
        // Guarda o original antes de regravar no formato novo (sem credenciais).
        await this._writeBackup(id, raw, `pre-migracao-v${raw.schemaVersion}`);
        await writeFileAtomic(file, JSON.stringify(m, null, 2));
        this.log.warn(`Reunião ${id} migrada do esquema v${raw.schemaVersion} para v${m.schemaVersion} (votação pública).`);
      }
      this._commit(m);
      return;
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.error(`Arquivo da reunião ${id} inválido (${err.message}); tentando backups.`);
    }
    const backups = await this._listBackups(id);
    for (const b of backups.reverse()) {
      try {
        const doc = JSON.parse(await fsp.readFile(b, 'utf8'));
        const m = validateMeeting(migrateMeeting(doc.meeting));
        if (m.id !== id) continue;
        await writeFileAtomic(file, JSON.stringify(m, null, 2));
        this._commit(m);
        this.log.warn(`Reunião ${id} recuperada do backup ${path.basename(b)} (versão ${m.version}).`);
        return;
      } catch {
        /* tenta o próximo backup */
      }
    }
    this.log.error(`Não foi possível recuperar a reunião ${id}.`);
  }

  _commit(m) {
    this.meetings.set(m.id, deepFreeze(m));
  }

  get(id) {
    return this.meetings.get(id) || null;
  }

  require(id) {
    const m = typeof id === 'string' ? this.get(id) : null;
    if (!m) throw new HttpError(404, 'meeting_not_found', 'Reunião não encontrada.');
    return m;
  }

  list() {
    return [...this.meetings.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  _enqueue(id, task) {
    const prev = this.queues.get(id) || Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => {});
    this.queues.set(id, tail);
    tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return run;
  }

  async _persist(m) {
    validateMeeting(m);
    await writeFileAtomic(path.join(this.meetingsDir, `${m.id}.json`), JSON.stringify(m, null, 2));
  }

  /** Cria uma reunião nova (id gerado em newMeeting). */
  create(meeting) {
    return this._enqueue(meeting.id, async () => {
      if (this.meetings.has(meeting.id)) throw new HttpError(409, 'conflict', 'Reunião já existe.');
      await this._persist(meeting);
      this._commit(meeting);
      return meeting;
    });
  }

  /**
   * Aplica fn(draft) atomicamente. Se fn lançar erro, nada é gravado.
   * Se fn retornar skip(valor), o estado não muda e nada é gravado.
   * Retorna { meeting, result } somente após a gravação durável.
   */
  mutate(id, fn) {
    return this._enqueue(id, async () => {
      const cur = this.require(id);
      const draft = structuredClone(cur);
      const result = await fn(draft);
      if (result && result[SKIP]) return { meeting: cur, result: result.value, skipped: true };
      draft.version = cur.version + 1;
      draft.updatedAt = now();
      await this._persist(draft);
      this._commit(draft);
      return { meeting: draft, result };
    });
  }

  /** Executa uma tarefa na fila da reunião sem alterar o estado (ex.: backup consistente). */
  withLock(id, fn) {
    return this._enqueue(id, async () => fn(this.require(id)));
  }

  // ---------- Ledger imutável (append-only, encadeado por hash) ----------

  ledgerFile(id) {
    return path.join(this.ledgerDir, `${id}.jsonl`);
  }

  async readLedger(id) {
    try {
      const text = await fsp.readFile(this.ledgerFile(id), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Acrescenta uma entrada no ledger. Deve ser chamado dentro da fila da reunião. */
  async appendLedger(id, entry) {
    const entries = await this.readLedger(id);
    const prevHash = entries.length ? entries[entries.length - 1].hash : '0'.repeat(64);
    const body = { seq: entries.length + 1, at: now(), prevHash, ...entry };
    const line = { ...body, hash: sha256(prevHash + JSON.stringify(body)) };
    await appendDurable(this.ledgerFile(id), JSON.stringify(line) + '\n');
    return line;
  }

  static verifyLedger(entries) {
    let prev = '0'.repeat(64);
    for (const [i, e] of entries.entries()) {
      const { hash, ...body } = e;
      if (body.seq !== i + 1 || body.prevHash !== prev || sha256(prev + JSON.stringify(body)) !== hash) return false;
      prev = hash;
    }
    return true;
  }

  // ---------- Exportação, importação e backups ----------

  async exportDoc(id) {
    const meeting = this.require(id);
    return {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: now(),
      meeting,
      ledger: await this.readLedger(id),
    };
  }

  async _listBackups(id) {
    const dir = path.join(this.backupsDir, id);
    try {
      return (await fsp.readdir(dir))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  /** Escreve o arquivo de backup (no formato de exportação) e aplica a retenção. */
  async _writeBackup(id, meeting, reason) {
    const dir = path.join(this.backupsDir, id);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = String(reason || 'manual').replace(/[^a-z0-9_-]/gi, '').slice(0, 30);
    this.backupSeq = ((this.backupSeq || 0) + 1) % 1000;
    const name = `${stamp}-${String(this.backupSeq).padStart(3, '0')}-v${String(meeting.version).padStart(6, '0')}-${safeReason}.json`;
    const doc = {
      format: EXPORT_FORMAT,
      schemaVersion: meeting.schemaVersion,
      exportedAt: now(),
      meeting,
      ledger: await this.readLedger(id),
    };
    await writeFileAtomic(path.join(dir, name), JSON.stringify(doc));
    const all = await this._listBackups(id);
    for (const old of all.slice(0, Math.max(0, all.length - this.backupKeep))) await fsp.rm(old, { force: true });
    return name;
  }

  /** Grava um backup versionado. Mantém os mais recentes; nunca remove o mais novo. */
  backup(id, reason) {
    return this.withLock(id, (m) => this._writeBackup(id, m, reason));
  }

  async listBackups(id) {
    return (await this._listBackups(id)).map((f) => path.basename(f));
  }

  /**
   * Importa um arquivo exportado. Valida estrutura, hashes dos resultados e o ledger.
   * Nunca sobrescreve uma reunião existente (resultados finalizados são imutáveis).
   */
  importDoc(doc) {
    if (!doc || doc.format !== EXPORT_FORMAT) throw new HttpError(400, 'invalid_data', 'Arquivo não é uma exportação NOMEIA.');
    if (![1, SCHEMA_VERSION].includes(doc.schemaVersion)) throw new HttpError(400, 'invalid_data', 'Versão de esquema não suportada.');
    // Exportações v1 (com credenciais) são convertidas: contagens e resultados selados são preservados.
    const m = validateMeeting(migrateMeeting(structuredClone(doc.meeting)), { checkHashes: true });
    const ledger = Array.isArray(doc.ledger) ? doc.ledger : [];
    if (!Store.verifyLedger(ledger)) throw new HttpError(400, 'invalid_data', 'Ledger inválido ou adulterado.');
    return this._enqueue(m.id, async () => {
      if (this.meetings.has(m.id)) {
        throw new HttpError(409, 'meeting_exists', 'Já existe uma reunião com este ID. Importação recusada para não sobrescrever resultados.');
      }
      await this._persist(m);
      if (ledger.length) {
        await writeFileAtomic(this.ledgerFile(m.id), ledger.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
      this._commit(m);
      return m;
    });
  }

  /** Aguarda todas as filas pendentes (usado no encerramento do servidor). */
  async drain() {
    await Promise.all([...this.queues.values()]);
  }
}

module.exports = { Store, writeFileAtomic, EXPORT_FORMAT, deepFreeze, skip };
