const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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
`);

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

// ---- users table: rebuilt to the final shape if an older version exists ----
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
const usersTableExists = userCols.length > 0;
const needsUserRebuild = usersTableExists && !userCols.includes('is_admin');

const USERS_CREATE_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT,
    password_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_super_admin INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    otp_code TEXT,
    otp_expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
`;

if (!usersTableExists) {
  db.exec(USERS_CREATE_SQL);
} else if (needsUserRebuild) {
  db.exec(`
    ALTER TABLE users RENAME TO users_old;
    ${USERS_CREATE_SQL}
    INSERT INTO users (id, username, password_hash, is_admin, verified, created_at)
      SELECT id, username, password_hash, CASE WHEN role='admin' THEN 1 ELSE 0 END, 1, created_at
      FROM users_old;
    DROP TABLE users_old;
  `);
  console.log('Migrated users table to the new account/role schema. Existing accounts kept their passwords and admin status, but have no email on file yet and are not assigned to any specific event - use Team Details to add their email and assign them to events again.');
}

// Add is_super_admin to installs that already had the post-migration schema
// but predate the super-admin concept.
const userColsNow = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColsNow.includes('is_super_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email)');

// Guarantee exactly one main admin always exists once any admin exists at
// all - this is what makes the "nobody can remove the main admin" rule
// deadlock-proof: pick one deterministically if none is flagged yet.
const superAdminCount = db.prepare('SELECT COUNT(*) c FROM users WHERE is_super_admin = 1').get().c;
if (superAdminCount === 0) {
  const byUsername = db.prepare("SELECT id FROM users WHERE is_admin = 1 AND username = 'admin'").get();
  const earliestAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1').get();
  const pick = byUsername || earliestAdmin;
  if (pick) {
    db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(pick.id);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS event_members (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('employee','scanner')),
  PRIMARY KEY (event_id, user_id)
);
`);

const eventCount = db.prepare('SELECT COUNT(*) c FROM events').get().c;
if (eventCount === 0) {
  const legacyName = getSetting('eventName', null);
  const defaultName = legacyName || process.env.EVENT_NAME || 'My Event';
  db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)').run('default', defaultName, Date.now());
}

// ---- bootstrap the first (main) admin account from env vars ----
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const bootUser = process.env.ADMIN_USERNAME;
  const bootEmail = process.env.ADMIN_EMAIL || null;
  const bootPass = process.env.ADMIN_PASSWORD;
  if (bootUser && bootPass) {
    const hash = bcrypt.hashSync(bootPass, 10);
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, is_admin, is_super_admin, verified, created_at) VALUES (?, ?, ?, ?, 1, 1, 1, ?)'
    ).run(crypto.randomBytes(8).toString('hex'), bootUser, bootEmail, hash, Date.now());
    console.log(`Created the main admin account "${bootUser}"${bootEmail ? ' (' + bootEmail + ')' : ''} from ADMIN_USERNAME/ADMIN_PASSWORD. This account can never be demoted or removed by anyone.`);
  } else {
    console.warn('No users exist yet and ADMIN_USERNAME/ADMIN_PASSWORD are not set in .env - nobody can log in until you set them and restart.');
  }
}

// ================= events =================
function listEvents() {
  const events = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  return events.map((e) => {
    const total = db.prepare('SELECT COUNT(*) c FROM students WHERE event_id = ?').get(e.id).c;
    const used = db.prepare("SELECT COUNT(*) c FROM students WHERE event_id = ? AND status = 'used'").get(e.id).c;
    return { ...e, total, used, pending: total - used };
  });
}
function getEvent(id) { return db.prepare('SELECT * FROM events WHERE id = ?').get(id); }
function createEvent(name) {
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
  return getEvent(id);
}
function renameEvent(id, name) {
  db.prepare('UPDATE events SET name = ? WHERE id = ?').run(name, id);
  return getEvent(id);
}

// ================= users / accounts =================
const SAFE_USER_COLS = 'id, username, email, is_admin, is_super_admin, verified, created_at';

// Only surfaces accounts that are actually ready to use: either an admin
// pre-added them with a password already set, or they self-signed-up,
// verified their email via OTP, AND finished setting a password. A
// self-signup that's mid-flow (email not yet verified, or verified but no
// password chosen yet) — and an admin-added placeholder still waiting to be
// claimed — should not show up in the team directory / central team list
// until that's actually complete.
function listAllUsers() {
  return db.prepare(
    `SELECT ${SAFE_USER_COLS} FROM users WHERE verified = 1 AND password_hash IS NOT NULL ORDER BY created_at ASC`
  ).all();
}
function getUserById(id) {
  return db.prepare(`SELECT ${SAFE_USER_COLS} FROM users WHERE id = ?`).get(id);
}
function getUserByEmailFull(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
function getUserByUsernameFull(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function countAdmins() {
  return db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c;
}

// Admin adds someone to the directory. If a password is given, the account
// is immediately usable (no signup/OTP needed). If not, it's a placeholder
// that gets "claimed" (see startSignup) when that person signs up themselves.
function adminAddUser({ email, username, password, isAdmin }) {
  const existing = getUserByEmailFull(email);
  if (existing) return null;
  const id = crypto.randomBytes(8).toString('hex');
  const hasPassword = !!password;
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, is_admin, verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, username || email.split('@')[0], email,
    hasPassword ? bcrypt.hashSync(password, 10) : null,
    isAdmin ? 1 : 0,
    hasPassword ? 1 : 0,
    Date.now()
  );
  return getUserById(id);
}

function genOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function startSignup(email, username) {
  const existing = getUserByEmailFull(email);
  if (existing && existing.password_hash && existing.verified) return null;
  const otp = genOtp();
  const expires = Date.now() + 10 * 60 * 1000;
  if (existing) {
    db.prepare('UPDATE users SET username = ?, otp_code = ?, otp_expires_at = ? WHERE id = ?')
      .run(username, otp, expires, existing.id);
    return { user: getUserById(existing.id), otp };
  }
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(
    'INSERT INTO users (id, username, email, is_admin, verified, otp_code, otp_expires_at, created_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)'
  ).run(id, username, email, otp, expires, Date.now());
  return { user: getUserById(id), otp };
}

function verifyOtp(email, code) {
  const user = getUserByEmailFull(email);
  if (!user || !user.otp_code || user.otp_code !== String(code)) return null;
  if (!user.otp_expires_at || Date.now() > user.otp_expires_at) return null;
  db.prepare('UPDATE users SET verified = 1, otp_code = NULL, otp_expires_at = NULL WHERE id = ?').run(user.id);
  return getUserById(user.id);
}

function setPassword(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}
function updateUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
function setUserAdmin(id, isAdmin) {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  return getUserById(id);
}
function deleteUser(id) {
  db.prepare('DELETE FROM event_members WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ================= event membership =================
function listEventMembers(eventId) {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.email, u.is_admin, em.role AS assigned_role
    FROM event_members em JOIN users u ON u.id = em.user_id
    WHERE em.event_id = ?
    ORDER BY u.username ASC
  `).all(eventId);
  // If someone was assigned employee/scanner and later became a global
  // admin, show their real current status (ADMIN), not the stale
  // event-level role that was set before the promotion.
  return rows.map((r) => ({
    id: r.id, username: r.username, email: r.email,
    is_admin: !!r.is_admin,
    role: r.is_admin ? 'admin' : r.assigned_role
  }));
}
function getEventMemberRole(eventId, userId) {
  const row = db.prepare('SELECT role FROM event_members WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  return row ? row.role : null;
}
function addOrUpdateEventMember(eventId, userId, role) {
  db.prepare(`
    INSERT INTO event_members (event_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET role = excluded.role
  `).run(eventId, userId, role);
}
function removeEventMember(eventId, userId) {
  db.prepare('DELETE FROM event_members WHERE event_id = ? AND user_id = ?').run(eventId, userId);
}
function listEventsForUser(userId) {
  const rows = db.prepare(`
    SELECT e.*, em.role FROM event_members em
    JOIN events e ON e.id = em.event_id
    WHERE em.user_id = ?
    ORDER BY e.created_at DESC
  `).all(userId);
  return rows.map((e) => {
    const total = db.prepare('SELECT COUNT(*) c FROM students WHERE event_id = ?').get(e.id).c;
    const used = db.prepare("SELECT COUNT(*) c FROM students WHERE event_id = ? AND status = 'used'").get(e.id).c;
    return { ...e, total, used, pending: total - used };
  });
}

// Cumulative: admin (incl. de-facto for every event) > employee > scanner.
function userHasEventAccess(user, eventId, minRole) {
  if (user.isAdmin) return true;
  const role = getEventMemberRole(eventId, user.sub);
  if (!role) return false;
  if (minRole === 'scanner') return role === 'scanner' || role === 'employee';
  if (minRole === 'employee') return role === 'employee';
  return false;
}

// ================= admin secret key =================
function getAdminKeyHash() { return getSetting('admin_action_key_hash', null); }
function setAdminKeyHash(hash) { setSetting('admin_action_key_hash', hash); }
function checkAdminKey(plain) {
  const hash = getAdminKeyHash();
  if (!hash) return false;
  return bcrypt.compareSync(String(plain || ''), hash);
}

// ================= scan dedupe =================
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
  listAllUsers, getUserById, getUserByEmailFull, getUserByUsernameFull, countAdmins,
  adminAddUser, startSignup, verifyOtp, setPassword, updateUserPassword,
  setUserAdmin, deleteUser,
  listEventMembers, getEventMemberRole, addOrUpdateEventMember, removeEventMember,
  listEventsForUser, userHasEventAccess,
  getAdminKeyHash, setAdminKeyHash, checkAdminKey
};
