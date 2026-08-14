const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Allow the database file location to be overridden (e.g. a mounted
// persistent volume on Railway/Render), so data survives restarts/redeploys.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'gatekeep.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  token TEXT PRIMARY KEY,
  event_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  student_id TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'unused',
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  mail_sent INTEGER NOT NULL DEFAULT 0,
  mail_error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','scanner')),
  created_at INTEGER NOT NULL
);
`);

// ---- Migration: older DBs created before multi-event support ----
const studentCols = db.prepare("PRAGMA table_info(students)").all().map((c) => c.name);
if (!studentCols.includes('event_id')) {
  db.exec("ALTER TABLE students ADD COLUMN event_id TEXT NOT NULL DEFAULT 'default'");
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Make sure at least one event exists (covers both brand-new installs and
// upgrades from a pre-events version of the database).
const eventCount = db.prepare('SELECT COUNT(*) c FROM events').get().c;
if (eventCount === 0) {
  const legacyName = getSetting('eventName', null);
  const defaultName = legacyName || process.env.EVENT_NAME || 'My Event';
  db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)').run('default', defaultName, Date.now());
}

// ---- Bootstrap the first admin account from env vars, if no users exist yet ----
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const bootUser = process.env.ADMIN_USERNAME;
  const bootPass = process.env.ADMIN_PASSWORD;
  if (bootUser && bootPass) {
    const hash = bcrypt.hashSync(bootPass, 10);
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomBytes(8).toString('hex'), bootUser, hash, 'admin', Date.now());
    console.log(`Created initial admin account "${bootUser}" from ADMIN_USERNAME/ADMIN_PASSWORD.`);
  } else {
    console.warn('No users exist yet and ADMIN_USERNAME/ADMIN_PASSWORD are not set in .env — nobody can log in until you set them and restart.');
  }
}

// ---------- events ----------
function listEvents() {
  const events = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  return events.map((e) => {
    const total = db.prepare('SELECT COUNT(*) c FROM students WHERE event_id = ?').get(e.id).c;
    const used = db.prepare("SELECT COUNT(*) c FROM students WHERE event_id = ? AND status = 'used'").get(e.id).c;
    return { ...e, total, used, pending: total - used };
  });
}
function getEvent(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}
function createEvent(name) {
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
  return getEvent(id);
}
function renameEvent(id, name) {
  db.prepare('UPDATE events SET name = ? WHERE id = ?').run(name, id);
  return getEvent(id);
}

// ---------- users ----------
function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all();
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function getUserById(id) {
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
}
function countAdmins() {
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
}
function createUser({ username, passwordHash, role }) {
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, passwordHash, role, Date.now());
  return getUserById(id);
}
function updateUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
function updateUserRole(id, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}
function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// Atomic scan-and-mark - runs as a single synchronous transaction so two
// simultaneous scans of the same code cannot both succeed. Tokens are
// globally unique, so scanning never needs to know which event is "active".
const verifyTxn = db.transaction((token) => {
  const rec = db.prepare('SELECT * FROM students WHERE token = ?').get(token);
  if (!rec) return { result: 'invalid' };
  if (rec.status === 'used') return { result: 'already', record: rec };
  const usedAt = Date.now();
  db.prepare('UPDATE students SET status = ?, used_at = ? WHERE token = ?').run('used', usedAt, token);
  rec.status = 'used';
  rec.used_at = usedAt;
  return { result: 'verified', record: rec };
});

module.exports = {
  db, getSetting, setSetting, verifyTxn,
  listEvents, getEvent, createEvent, renameEvent,
  listUsers, getUserByUsername, getUserById, countAdmins,
  createUser, updateUserPassword, updateUserRole, deleteUser
};
