'use strict';
/* Buffalo server: Express + SQLite (built into Node 22.13+).
 * - Passwords hashed with scrypt, sessions in httpOnly cookies, login rate-limit.
 * - Every action is checked against the user's role on the server (the browser is never trusted).
 * - Business rules (stock checks, costing) are the same logic.js the browser uses. */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const L = require('./public/logic.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_HOURS = 8;
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'buffalo.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

/* ---------- passwords & sessions ---------- */
const ROLES = ['admin', 'accountant', 'storekeeper'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function newPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: scrypt(pw, salt) }; }
function checkPw(pw, u) {
  const a = Buffer.from(scrypt(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function createUser({ username, name, role, password }) {
  const { salt, hash } = newPw(password);
  db.prepare('INSERT INTO users(username,name,role,salt,hash,created) VALUES(?,?,?,?,?,?)')
    .run(username, name, role, salt, hash, new Date().toISOString().slice(0, 10));
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('Password must be at least 8 characters.');
  if (pw.length > 100) throw new Error('Password is too long.');
}

// first run: create starter accounts (change these passwords after signing in!)
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  createUser({ username: 'admin', name: 'Administrator', role: 'admin', password: 'Buffalo@2026' });
  createUser({ username: 'accountant', name: 'Accountant', role: 'accountant', password: 'Account@2026' });
  createUser({ username: 'storekeeper', name: 'Storekeeper', role: 'storekeeper', password: 'Store@2026' });
  console.log('First run: created users admin / accountant / storekeeper (see README for the starter passwords).');
}

/* ---------- state (one JSON document, changed only inside a transaction) ---------- */
const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
function getState() {
  const r = db.prepare("SELECT value FROM kv WHERE key='state'").get();
  if (r) return JSON.parse(r.value);
  const s = L.demoData(todayStr()); setState(s); return s;
}
function setState(s) {
  db.prepare("INSERT INTO kv(key,value) VALUES('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s));
}
function viewFor(role, s) {
  if (role !== 'storekeeper') return s;
  const c = JSON.parse(JSON.stringify(s));   // storekeepers never see prices, customers or expenses
  c.sales = c.sales.map((x) => ({ id: x.id, date: x.date, productId: x.productId, qty: x.qty, unitPrice: 0, unitCost: 0, customer: '' }));
  c.expenses = [];
  c.products.forEach((p) => { p.price = 0; });
  return c;
}

/* ---------- validation ---------- */
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const needDate = (v) => { if (!isDate(v)) throw new Error('Choose a valid date.'); return v; };
const needNum = (v, label) => { const n = typeof v === 'number' ? v : parseFloat(v); if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new Error('Enter a valid ' + label + '.'); return n; };
const str = (v, max = 80) => String(v == null ? '' : v).trim().slice(0, max);
const needStr = (v, label, max = 80) => { const s = str(v, max); if (!s) throw new Error(label + ' is required.'); return s; };

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {            // CSRF guard on top of SameSite cookies
  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
  if (req.method !== 'GET' && req.method !== 'HEAD' && hasBody && !req.is('application/json')) {
    return res.status(415).json({ error: 'JSON only.' });
  }
  next();
});

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  res.append('Set-Cookie', 'buffalo_sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAgeSec + (req.secure ? '; Secure' : ''));
}
function auth(req, res, next) {
  const tok = parseCookies(req).buffalo_sid;
  const row = tok && db.prepare('SELECT u.id, u.username, u.name, u.role, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(sha(tok));
  if (!row || row.expires < Date.now()) return res.status(401).json({ error: 'Please sign in.' });
  req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
  req.tokenHash = sha(tok);
  next();
}
const need = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role is not allowed to do this.' });
const mutate = (fn) => (req, res) => {
  try {
    db.exec('BEGIN');
    const s = getState();
    const out = fn(s, req) || {};
    setState(s);
    db.exec('COMMIT');
    res.json({ ok: true, ...out });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* no open transaction */ }
    res.status(400).json({ error: e.message });
  }
};

/* ---------- login / logout ---------- */
const fails = new Map();
app.post('/api/login', (req, res) => {
  const username = str(req.body && req.body.username, 50), password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const key = req.ip + '|' + username.toLowerCase();
  const f = fails.get(key);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = u && password.length <= 100 && checkPw(password, u);
  if (!ok) {
    const n = (f ? f.count : 0) + 1;
    fails.set(key, { count: n, until: n >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  fails.delete(key);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(sha(token), u.id, Date.now() + SESSION_HOURS * 3600 * 1000);
  setSessionCookie(req, res, token, SESSION_HOURS * 3600);
  res.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});
app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.tokenHash);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));
app.post('/api/me/password', auth, (req, res) => {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!checkPw(String(req.body.current || ''), u)) throw new Error('Current password is wrong.');
    checkPassword(req.body.next);
    const { salt, hash } = newPw(req.body.next);
    db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.tokenHash);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- data ---------- */
app.get('/api/state', auth, (req, res) => res.json({ user: req.user, state: viewFor(req.user.role, getState()) }));

app.post('/api/purchases', auth, need('admin', 'accountant', 'storekeeper'), mutate((s, req) => {
  const b = req.body;
  L.addPurchase(s, { date: needDate(b.date), materialId: str(b.materialId, 60), qty: needNum(b.qty, 'quantity'), unitCost: needNum(b.unitCost, 'unit cost'), supplier: str(b.supplier) });
}));
app.post('/api/productions', auth, need('admin', 'storekeeper'), mutate((s, req) => {
  const b = req.body;
  L.makeProduction(s, { date: needDate(b.date), productId: str(b.productId, 60), qty: needNum(b.qty, 'quantity') });
}));
app.post('/api/sales', auth, need('admin', 'accountant'), mutate((s, req) => {
  const b = req.body;
  L.makeSale(s, { date: needDate(b.date), productId: str(b.productId, 60), qty: needNum(b.qty, 'quantity'), unitPrice: needNum(b.unitPrice, 'price'), customer: str(b.customer) });
}));
app.post('/api/expenses', auth, need('admin', 'accountant'), mutate((s, req) => {
  const b = req.body;
  if (!L.EXPENSE_CATEGORIES.includes(b.category)) throw new Error('Choose a category.');
  L.addExpense(s, { date: needDate(b.date), category: b.category, amount: needNum(b.amount, 'amount'), note: str(b.note, 120) });
}));

const COLLECTIONS = ['purchases', 'productions', 'sales', 'expenses'];
app.delete('/api/:collection/:id', auth, need('admin'), (req, res, next) => {
  if (!COLLECTIONS.includes(req.params.collection)) return next();
  mutate((s) => { const r = L.removeEntry(s, req.params.collection, req.params.id); if (!r.ok) throw new Error(r.error); })(req, res);
});

/* setup (admin) */
app.post('/api/materials', auth, need('admin'), mutate((s, req) => {
  s.materials.push({ id: L.uid('m'), name: needStr(req.body.name, 'Name'), unit: needStr(req.body.unit, 'Unit', 15), reorder: needNum(req.body.reorder || 0, 'reorder level') });
}));
app.post('/api/products', auth, need('admin'), mutate((s, req) => {
  s.products.push({ id: L.uid('p'), name: needStr(req.body.name, 'Name'), unit: needStr(req.body.unit, 'Unit', 15), minStock: needNum(req.body.minStock || 0, 'min stock'), price: needNum(req.body.price || 0, 'price'), recipe: [] });
}));
app.patch('/api/materials/:id', auth, need('admin'), mutate((s, req) => {
  const m = L.byId(s.materials, req.params.id); if (!m) throw new Error('Not found.');
  m.reorder = needNum(req.body.reorder, 'reorder level');
}));
app.patch('/api/products/:id', auth, need('admin'), mutate((s, req) => {
  const p = L.byId(s.products, req.params.id); if (!p) throw new Error('Not found.');
  if (req.body.price !== undefined) p.price = needNum(req.body.price, 'price');
  if (req.body.minStock !== undefined) p.minStock = needNum(req.body.minStock, 'min stock');
}));
app.post('/api/products/:id/recipe', auth, need('admin'), mutate((s, req) => {
  const p = L.byId(s.products, req.params.id); if (!p) throw new Error('Not found.');
  const materialId = str(req.body.materialId, 60), qty = needNum(req.body.qty, 'quantity'), scrapPct = needNum(req.body.scrapPct || 0, 'scrap %');
  if (!L.byId(s.materials, materialId)) throw new Error('Choose a material.');
  if (!(qty > 0)) throw new Error('Quantity must be greater than zero.');
  if (p.recipe.some((l) => l.materialId === materialId)) throw new Error('That material is already in the recipe.');
  p.recipe.push({ materialId, qty, scrapPct });
}));
app.delete('/api/products/:id/recipe/:idx', auth, need('admin'), mutate((s, req) => {
  const p = L.byId(s.products, req.params.id); if (!p) throw new Error('Not found.');
  const i = parseInt(req.params.idx, 10);
  if (!(i >= 0 && i < p.recipe.length)) throw new Error('Not found.');
  p.recipe.splice(i, 1);
}));

/* data tools (admin) */
app.post('/api/admin/reset-demo', auth, need('admin'), mutate((s) => { Object.assign(s, L.demoData(todayStr())); }));
app.post('/api/admin/clear', auth, need('admin'), mutate((s) => { Object.assign(s, L.emptyData()); }));
app.post('/api/admin/import', auth, need('admin'), mutate((s, req) => {
  const b = req.body;
  ['materials', 'products', 'purchases', 'productions', 'sales', 'expenses'].forEach((k) => { if (!Array.isArray(b[k])) throw new Error('Not a valid Buffalo backup.'); });
  if (!b.products.every((p) => p && Array.isArray(p.recipe))) throw new Error('Not a valid Buffalo backup.');
  Object.assign(s, { materials: b.materials, products: b.products, purchases: b.purchases, productions: b.productions, sales: b.sales, expenses: b.expenses });
}));

/* ---------- users (admin) ---------- */
app.get('/api/users', auth, need('admin'), (req, res) => res.json({ users: db.prepare('SELECT id, username, name, role, created FROM users ORDER BY id').all() }));
app.post('/api/users', auth, need('admin'), (req, res) => {
  try {
    const username = needStr(req.body.username, 'Username', 30), name = needStr(req.body.name, 'Name', 60), role = req.body.role;
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw new Error('Username: 3-30 letters, numbers, . _ -');
    if (!ROLES.includes(role)) throw new Error('Choose a role.');
    checkPassword(req.body.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('That username is taken.');
    createUser({ username, name, role, password: req.body.password });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/users/:id/password', auth, need('admin'), (req, res) => {
  try {
    checkPassword(req.body.password);
    const id = parseInt(req.params.id, 10);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new Error('Not found.');
    const { salt, hash } = newPw(req.body.password);
    db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/users/:id', auth, need('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log('Buffalo running at http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT));
}
module.exports = app;
