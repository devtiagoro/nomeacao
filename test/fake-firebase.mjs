// Banco em memória com a mesma API modular do SDK do Firebase usada por public/js/db.js.
// Serve apenas para testar o fluxo de sincronização entre telas sem rede; NÃO aplica as
// regras de segurança (essas são testadas no emulador oficial: npm run test:rules).

let root = {};
const listeners = new Set();
let clock = 1_760_000_000_000;

const parts = (p) => String(p || '').split('/').filter(Boolean);
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function getAt(path) {
  let node = root;
  for (const k of parts(path)) {
    if (node === null || typeof node !== 'object') return null;
    node = node[k];
  }
  return node === undefined ? null : node;
}

function setAt(path, value) {
  const keys = parts(path);
  if (!keys.length) {
    root = value ?? {};
    return;
  }
  const stack = [root];
  let node = root;
  for (const k of keys.slice(0, -1)) {
    if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
    stack.push(node);
  }
  const last = keys.at(-1);
  if (value === null || value === undefined) delete node[last];
  else node[last] = value;
  // Remove objetos que ficaram vazios, como o Realtime Database.
  for (let i = keys.length - 1; i > 0; i--) if (!Object.keys(stack[i]).length) delete stack[i - 1][keys[i - 1]];
}

function resolve(value, current) {
  if (value && typeof value === 'object') {
    if ('__inc' in value) return (typeof current === 'number' ? current : 0) + value.__inc;
    if (value.__ts) return ++clock;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolve(v, current?.[k]);
      if (r !== null && r !== undefined) out[k] = r;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

function write(entries) {
  for (const [path, value] of Object.entries(entries)) setAt(path, resolve(value, getAt(path)));
  const touched = Object.keys(entries).map(parts);
  for (const l of [...listeners]) {
    const lp = parts(l.path);
    const hit = touched.some((t) => t.slice(0, lp.length).join('/') === lp.slice(0, t.length).join('/'));
    if (hit) l.cb(snap(l.path));
  }
}

const snap = (path) => ({ val: () => (path === '.info/connected' ? true : clone(getAt(path))) });

export function reset() {
  root = {};
  listeners.clear();
}

export const dump = () => clone(root);

// --- firebase-app / firebase-auth (o mínimo) ---
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const connectAuthEmulator = () => {};
export const onAuthStateChanged = (auth, cb) => (cb(null), () => {});

// --- firebase-database ---
export const getDatabase = () => ({});
export const connectDatabaseEmulator = () => {};
export const ref = (db, path = '') => ({ path: parts(path).join('/') });
export const increment = (n) => ({ __inc: n });
export const serverTimestamp = () => ({ __ts: true });
export const get = async (r) => snap(r.path);
export const set = async (r, value) => write({ [r.path]: value });
export const remove = async (r) => write({ [r.path]: null });
export async function update(r, values) {
  const entries = {};
  for (const [k, v] of Object.entries(values)) entries[[r.path, k].filter(Boolean).join('/')] = v;
  write(entries);
}
export function onValue(r, cb) {
  const l = { path: r.path, cb };
  listeners.add(l);
  cb(snap(r.path));
  return () => listeners.delete(l);
}
