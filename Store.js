// store.js — SQLite-backed store.
// ---------------------------------------------------------------------------
// Durable across restarts WHEN the database file sits on persistent storage.
// On Render, attach a Disk and set DB_PATH to a path on it (e.g. /var/data/nuru.db).
// Without a persistent disk the file is wiped on redeploy, so do attach one
// before your real event. Same method names as before, so server.js is unchanged.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'nuru.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  reference TEXT PRIMARY KEY,
  provider TEXT, status TEXT,
  tier TEXT, tierName TEXT, qty INTEGER, amount INTEGER,
  name TEXT, email TEXT, phone TEXT,
  ticketId TEXT, receipt TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  tier TEXT, tierName TEXT, qty INTEGER,
  name TEXT, email TEXT, phone TEXT,
  receipt TEXT, used INTEGER DEFAULT 0,
  issuedAt TEXT, usedAt TEXT
);
`);

const ORDER_COLS = ['reference', 'provider', 'status', 'tier', 'tierName', 'qty',
  'amount', 'name', 'email', 'phone', 'ticketId', 'receipt', 'createdAt'];

const upsertOrder = db.prepare(
  `INSERT OR REPLACE INTO orders (${ORDER_COLS.join(',')}) ` +
  `VALUES (${ORDER_COLS.map((c) => '@' + c).join(',')})`
);
const getOrderStmt = db.prepare('SELECT * FROM orders WHERE reference = ?');

const upsertTicket = db.prepare(
  `INSERT OR REPLACE INTO tickets
   (id,tier,tierName,qty,name,email,phone,receipt,used,issuedAt,usedAt)
   VALUES (@id,@tier,@tierName,@qty,@name,@email,@phone,@receipt,@used,@issuedAt,@usedAt)`
);
const getTicketStmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
const soldStmt = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM tickets');
const allTicketsStmt = db.prepare('SELECT * FROM tickets ORDER BY issuedAt DESC');
const setUsedStmt = db.prepare('UPDATE tickets SET used=1, usedAt=? WHERE id=?');

function orderRow(o) {
  const row = {};
  ORDER_COLS.forEach((c) => { row[c] = o[c] !== undefined ? o[c] : null; });
  return row;
}

module.exports = {
  saveOrder(reference, order) {
    upsertOrder.run(orderRow({ ...order, reference }));
    return getOrderStmt.get(reference);
  },
  getOrder(reference) { return getOrderStmt.get(reference) || null; },
  updateOrder(reference, patch) {
    const cur = getOrderStmt.get(reference);
    if (!cur) return null;
    upsertOrder.run(orderRow({ ...cur, ...patch }));
    return getOrderStmt.get(reference);
  },

  saveTicket(t) {
    upsertTicket.run({
      id: t.id,
      tier: t.tier || null, tierName: t.tierName || null, qty: t.qty || 0,
      name: t.name || null, email: t.email || null, phone: t.phone || null,
      receipt: t.receipt || null, used: t.used ? 1 : 0,
      issuedAt: t.issuedAt || new Date().toISOString(), usedAt: t.usedAt || null
    });
    return this.getTicket(t.id);
  },
  getTicket(id) {
    const r = getTicketStmt.get(id);
    if (!r) return null;
    r.used = !!r.used;
    return r;
  },
  markUsed: db.transaction((id) => {
    const t = getTicketStmt.get(id);
    if (!t) return { ok: false, ticket: null, reason: 'Not found' };
    if (t.used) { t.used = true; return { ok: false, ticket: t, reason: 'Already checked in' }; }
    setUsedStmt.run(new Date().toISOString(), id);
    const nt = getTicketStmt.get(id); nt.used = true;
    return { ok: true, ticket: nt, reason: 'Checked in' };
  }),

  countSold() { return soldStmt.get().n; },
  allTickets() { return allTicketsStmt.all(); }
};
