require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const {
  db, listEvents, getEvent, createEvent, renameEvent, verifyTxn,
  listUsers, getUserByUsername, getUserById, countAdmins,
  createUser, updateUserPassword, updateUserRole, deleteUser
} = require('./db');
const { sendPassEmail } = require('./mailer');
const { signToken, verifyToken, hashPassword, checkPassword } = require('./auth');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set in .env. Set it to a long random string and restart.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function genToken() {
  return crypto.randomBytes(9).toString('hex').toUpperCase();
}

// ---------- auth middleware ----------
function requireAuth(req, res, next) {
  const header = req.header('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || req.query.token || '';
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  req.user = payload; // { sub, username, role }
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}
function requireEvent(req, res, next) {
  const eventId = req.header('x-event-id') || req.query.eventId || '';
  const event = eventId && getEvent(eventId);
  if (!event) return res.status(400).json({ error: 'Unknown or missing event (x-event-id)' });
  req.eventId = event.id;
  req.event = event;
  next();
}

// ---------- auth routes ----------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && getUserByUsername(username);
  if (!user || !checkPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  const token = signToken(user);
  res.json({ token, username: user.username, role: user.role });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = getUserByUsername(req.user.username);
  if (!user || !checkPassword(oldPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  updateUserPassword(user.id, hashPassword(newPassword));
  res.json({ ok: true });
});

// ---------- user management (admin only) ----------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(listUsers());
});
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['admin', 'scanner'].includes(role)) return res.status(400).json({ error: 'role must be admin or scanner' });
  if (getUserByUsername(username)) return res.status(409).json({ error: 'That username is already taken' });
  const user = createUser({ username, passwordHash: hashPassword(password), role });
  res.json(user);
});
app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const { role, password } = req.body || {};
  if (role) {
    if (!['admin', 'scanner'].includes(role)) return res.status(400).json({ error: 'role must be admin or scanner' });
    if (target.role === 'admin' && role !== 'admin' && countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last remaining admin' });
    }
    updateUserRole(target.id, role);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    updateUserPassword(target.id, hashPassword(password));
  }
  res.json(getUserById(target.id));
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.user.sub) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (target.role === 'admin' && countAdmins() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last remaining admin' });
  }
  deleteUser(target.id);
  res.json({ ok: true });
});

// ---------- events (admin only) ----------
app.get('/api/events', requireAdmin, (req, res) => {
  res.json(listEvents());
});
app.post('/api/events', requireAdmin, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(createEvent(name));
});
app.patch('/api/events/:id', requireAdmin, (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'event not found' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(renameEvent(event.id, name));
});

// ---------- add single registrant (admin only), scoped to an event ----------
app.post('/api/students', requireAdmin, requireEvent, async (req, res) => {
  const { name, id: studentId, email } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

  const token = genToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO students (token, event_id, name, student_id, email, status, created_at, mail_sent)
     VALUES (?, ?, ?, ?, ?, 'unused', ?, 0)`
  ).run(token, req.eventId, name.trim(), studentId || '', email || '', now);

  let mailStatus = 'skipped';
  let mailError = null;
  if (email) {
    try {
      await sendPassEmail({ to: email, name, studentId, token, eventName: req.event.name });
      db.prepare('UPDATE students SET mail_sent = 1 WHERE token = ?').run(token);
      mailStatus = 'sent';
    } catch (e) {
      mailError = e.message;
      db.prepare('UPDATE students SET mail_error = ? WHERE token = ?').run(mailError, token);
      mailStatus = 'failed';
    }
  }

  res.json({ token, name, studentId, email, mailStatus, mailError });
});

// ---------- bulk add (admin only), scoped to an event ----------
app.post('/api/students/bulk', requireAdmin, requireEvent, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const results = [];

  for (const row of rows) {
    const name = (row.name || '').trim();
    if (!name) { results.push({ name: row.name, status: 'skipped-no-name' }); continue; }
    const token = genToken();
    const now = Date.now();
    db.prepare(
      `INSERT INTO students (token, event_id, name, student_id, email, status, created_at, mail_sent)
       VALUES (?, ?, ?, ?, ?, 'unused', ?, 0)`
    ).run(token, req.eventId, name, row.id || '', row.email || '', now);

    let mailStatus = 'skipped';
    if (row.email) {
      try {
        await sendPassEmail({ to: row.email, name, studentId: row.id, token, eventName: req.event.name });
        db.prepare('UPDATE students SET mail_sent = 1 WHERE token = ?').run(token);
        mailStatus = 'sent';
      } catch (e) {
        db.prepare('UPDATE students SET mail_error = ? WHERE token = ?').run(e.message, token);
        mailStatus = 'failed: ' + e.message;
      }
    }
    results.push({ name, token, email: row.email, mailStatus });
  }

  res.json({ created: results.length, results });
});

// ---------- resend email (admin only) ----------
app.post('/api/students/:token/resend', requireAdmin, async (req, res) => {
  const rec = db.prepare('SELECT * FROM students WHERE token = ?').get(req.params.token);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (!rec.email) return res.status(400).json({ error: 'no email on file' });
  const event = getEvent(rec.event_id) || { name: 'Event' };
  try {
    await sendPassEmail({ to: rec.email, name: rec.name, studentId: rec.student_id, token: rec.token, eventName: event.name });
    db.prepare('UPDATE students SET mail_sent = 1, mail_error = NULL WHERE token = ?').run(rec.token);
    res.json({ ok: true });
  } catch (e) {
    db.prepare('UPDATE students SET mail_error = ? WHERE token = ?').run(e.message, rec.token);
    res.status(500).json({ error: e.message });
  }
});

// ---------- list / stats (admin only), scoped to an event ----------
app.get('/api/students', requireAdmin, requireEvent, (req, res) => {
  const rows = db.prepare('SELECT * FROM students WHERE event_id = ? ORDER BY created_at DESC').all(req.eventId);
  res.json(rows);
});

app.get('/api/stats', requireAdmin, requireEvent, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM students WHERE event_id = ?').get(req.eventId).c;
  const used = db.prepare("SELECT COUNT(*) c FROM students WHERE event_id = ? AND status = 'used'").get(req.eventId).c;
  res.json({ total, used, pending: total - used });
});

// ---------- CSV export (admin only), scoped to an event ----------
app.get('/api/export.csv', requireAdmin, requireEvent, (req, res) => {
  const rows = db.prepare('SELECT * FROM students WHERE event_id = ? ORDER BY created_at DESC').all(req.eventId);
  let csv = 'name,id,email,token,status,mail_sent,used_at\n';
  for (const r of rows) {
    const usedAt = r.used_at ? new Date(r.used_at).toISOString() : '';
    csv += [r.name, r.student_id, r.email, r.token, r.status, r.mail_sent ? 'yes' : 'no', usedAt]
      .map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(',') + '\n';
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${(req.event.name || 'gatekeep').replace(/[^a-z0-9]+/gi, '-')}-roster.csv"`);
  res.send(csv);
});

// ---------- verify / scan (any logged-in user - admin or scanner) ----------
app.post('/api/verify', requireAuth, (req, res) => {
  const token = (req.body?.token || '').trim().toUpperCase();
  if (!token) return res.status(400).json({ error: 'token required' });
  const outcome = verifyTxn(token);
  res.json(outcome);
});

// ---------- reset (admin only) - clears only the CURRENT event's registrants ----------
app.post('/api/reset', requireAdmin, requireEvent, (req, res) => {
  db.prepare('DELETE FROM students WHERE event_id = ?').run(req.eventId);
  res.json({ ok: true });
});

// ---------- health (public) ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Gatekeep server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
