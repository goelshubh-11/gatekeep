require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const {
  db, listEvents, getEvent, createEvent, renameEvent,
  listAllUsers, getUserById, getUserByEmailFull, getUserByUsernameFull, countAdmins,
  adminAddUser, startSignup, verifyOtp, setPassword, updateUserPassword,
  setUserAdmin, deleteUser,
  listEventMembers, getEventMemberRole, addOrUpdateEventMember, removeEventMember,
  listEventsForUser, userHasEventAccess,
  getAdminKeyHash, setAdminKeyHash, checkAdminKey,
  verifyTxn
} = require('./db');
const { sendPassEmail, sendOtpEmail } = require('./mailer');
const { signToken, signSignupToken, verifyToken, hashPassword, checkPassword } = require('./auth');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set in .env. Set it to a long random string and restart.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function genToken() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }

// ================= auth middleware =================
function requireAuth(req, res, next) {
  const header = req.header('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || req.query.token || '';
  const payload = token && verifyToken(token);
  if (!payload || payload.purpose) return res.status(401).json({ error: 'Not authenticated' });
  req.user = payload; // { sub, username, isAdmin, isSuperAdmin }
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}
// minRole 'scanner' = scanner/employee/admin. minRole 'employee' = employee/admin.
// Admins are de-facto members of every event, always.
function requireEventRole(minRole) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      const eventId = req.header('x-event-id') || req.query.eventId || '';
      const event = eventId && getEvent(eventId);
      if (!event) return res.status(400).json({ error: 'Unknown or missing event (x-event-id)' });
      if (!userHasEventAccess(req.user, event.id, minRole)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
      }
      req.eventId = event.id;
      req.event = event;
      next();
    });
  };
}
function requireAdminKey(req, res, next) {
  const key = req.body && req.body.adminKey;
  if (!getAdminKeyHash()) {
    return res.status(400).json({ error: 'No admin secret key has been set yet. Set one from Team Details first.' });
  }
  if (!checkAdminKey(key)) return res.status(403).json({ error: 'Incorrect admin secret key' });
  next();
}

// ================= signup / OTP / login =================
app.post('/api/auth/signup', async (req, res) => {
  const { name, email } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  if (!cleanName || !cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ error: 'A valid name and email are required' });
  }
  const started = startSignup(cleanEmail, cleanName);
  if (!started) {
    return res.status(409).json({ error: 'An account with that email already exists. Please log in instead.' });
  }
  try {
    await sendOtpEmail({ to: cleanEmail, name: cleanName, otp: started.otp });
  } catch (e) {
    return res.status(500).json({ error: 'Could not send verification email: ' + e.message });
  }
  res.json({ ok: true, message: 'Verification code sent to your email.' });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const user = verifyOtp(cleanEmail, otp);
  if (!user) return res.status(400).json({ error: 'Incorrect or expired code' });
  res.json({ signupToken: signSignupToken(user) });
});

app.post('/api/auth/set-password', (req, res) => {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token && verifyToken(token);
  if (!payload || payload.purpose !== 'set-password') {
    return res.status(401).json({ error: 'Invalid or expired signup session - please verify your email again.' });
  }
  const { password, confirmPassword } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  setPassword(payload.sub, hashPassword(password));
  const user = getUserById(payload.sub);
  const loginToken = signToken(user);
  res.json({ token: loginToken, username: user.username, isAdmin: !!user.is_admin, isSuperAdmin: !!user.is_super_admin });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password } = req.body || {};
  const clean = String(identifier || '').trim().toLowerCase();
  const user = getUserByEmailFull(clean) || getUserByUsernameFull(identifier || '');
  if (!user || !user.verified || !checkPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email/username or password' });
  }
  const token = signToken(user);
  res.json({ token, username: user.username, isAdmin: !!user.is_admin, isSuperAdmin: !!user.is_super_admin });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = getUserById(req.user.sub);
  res.json({ username: user.username, email: user.email, isAdmin: !!user.is_admin, isSuperAdmin: !!user.is_super_admin });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!full || !checkPassword(oldPassword || '', full.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  updateUserPassword(full.id, hashPassword(newPassword));
  res.json({ ok: true });
});

// ================= landing page: events visible to me =================
app.get('/api/my-events', requireAuth, (req, res) => {
  if (req.user.isAdmin) {
    return res.json(listEvents().map((e) => ({ ...e, myRole: 'admin' })));
  }
  res.json(listEventsForUser(req.user.sub).map((e) => ({ ...e, myRole: e.role })));
});

// ================= events (admin only) =================
app.post('/api/events', requireAdmin, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(createEvent(name));
});
app.patch('/api/events/:id', requireAdmin, requireAdminKey, (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'event not found' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(renameEvent(event.id, name));
});
app.post('/api/reset', requireAdmin, requireAdminKey, (req, res) => {
  const eventId = req.header('x-event-id') || req.query.eventId || '';
  const event = eventId && getEvent(eventId);
  if (!event) return res.status(400).json({ error: 'Unknown or missing event' });
  db.prepare('DELETE FROM students WHERE event_id = ?').run(event.id);
  res.json({ ok: true });
});

// ================= registration / roster (employee+) =================
app.post('/api/students', requireEventRole('employee'), async (req, res) => {
  const { name, id: studentId, email } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const token = genToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO students (token, event_id, name, student_id, email, status, created_at, mail_sent)
     VALUES (?, ?, ?, ?, ?, 'unused', ?, 0)`
  ).run(token, req.eventId, name.trim(), studentId || '', email || '', now);

  let mailStatus = 'skipped', mailError = null;
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

app.post('/api/students/bulk', requireEventRole('employee'), async (req, res) => {
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

app.post('/api/students/:token/resend', requireAuth, async (req, res) => {
  const rec = db.prepare('SELECT * FROM students WHERE token = ?').get(req.params.token);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (!userHasEventAccess(req.user, rec.event_id, 'employee')) {
    return res.status(403).json({ error: 'You do not have access to this event' });
  }
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

app.get('/api/students', requireEventRole('employee'), (req, res) => {
  res.json(db.prepare('SELECT * FROM students WHERE event_id = ? ORDER BY created_at DESC').all(req.eventId));
});
app.get('/api/stats', requireEventRole('employee'), (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM students WHERE event_id = ?').get(req.eventId).c;
  const used = db.prepare("SELECT COUNT(*) c FROM students WHERE event_id = ? AND status = 'used'").get(req.eventId).c;
  res.json({ total, used, pending: total - used });
});
app.get('/api/export.csv', requireEventRole('employee'), (req, res) => {
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

// ================= scan / verify (scanner+, event-scoped after lookup) =================
app.post('/api/verify', requireAuth, (req, res) => {
  const token = (req.body?.token || '').trim().toUpperCase();
  if (!token) return res.status(400).json({ error: 'token required' });
  const rec = db.prepare('SELECT * FROM students WHERE token = ?').get(token);
  if (!rec) return res.json({ result: 'invalid' });
  if (!userHasEventAccess(req.user, rec.event_id, 'scanner')) {
    return res.status(403).json({ error: 'You do not have scanner access to this event' });
  }
  res.json(verifyTxn(token));
});

// ================= Team Details (central directory) =================
// Reading the directory is open to any logged-in user (needed to populate
// the "add to this event" picker for employees). Managing it is admin-only.
app.get('/api/team', requireAuth, (req, res) => {
  res.json(listAllUsers());
});

app.post('/api/team', requireAdmin, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const username = String(req.body?.username || '').trim() || email.split('@')[0];
  const password = req.body?.password ? String(req.body.password) : null;
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
  if (password && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role === 'admin' && !checkAdminKey(req.body?.adminKey)) {
    return res.status(403).json({ error: 'Incorrect admin secret key - required to grant admin at creation' });
  }
  const user = adminAddUser({ email, username, password, isAdmin: role === 'admin' });
  if (!user) return res.status(409).json({ error: 'That email is already in the directory' });
  res.json(user);
});

app.patch('/api/team/:id', requireAdmin, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const { isAdmin, adminKey } = req.body || {};

  if (isAdmin === true) {
    // Promotion: open to any admin, with the secret key.
    if (!checkAdminKey(adminKey)) return res.status(403).json({ error: 'Incorrect admin secret key' });
    setUserAdmin(target.id, true);
  } else if (isAdmin === false) {
    // Demotion: only the main admin can ever remove someone from admin,
    // and the main admin themselves can never be demoted by anyone.
    if (target.is_super_admin) {
      return res.status(403).json({ error: 'The main admin account can never be removed from admin.' });
    }
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ error: 'Only the main admin can remove someone from the admin role.' });
    }
    if (!checkAdminKey(adminKey)) return res.status(403).json({ error: 'Incorrect admin secret key' });
    if (target.is_admin && countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last remaining admin' });
    }
    setUserAdmin(target.id, false);
  }
  res.json(getUserById(target.id));
});

app.delete('/api/team/:id', requireAdmin, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.is_super_admin) {
    return res.status(403).json({ error: 'The main admin account can never be removed.' });
  }
  if (target.is_admin && !req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Only the main admin can remove an admin account.' });
  }
  if (target.id === req.user.sub) return res.status(400).json({ error: 'You cannot remove your own account' });
  deleteUser(target.id);
  res.json({ ok: true });
});

// ================= admin secret key management =================
app.get('/api/admin-key/status', requireAdmin, (req, res) => {
  res.json({ isSet: !!getAdminKeyHash() });
});
app.post('/api/admin-key', requireAdmin, (req, res) => {
  const { currentKey, newKey } = req.body || {};
  if (!newKey || newKey.length < 6) return res.status(400).json({ error: 'New key must be at least 6 characters' });
  const alreadySet = !!getAdminKeyHash();
  if (alreadySet && !checkAdminKey(currentKey)) {
    return res.status(403).json({ error: 'Current admin key is incorrect' });
  }
  setAdminKeyHash(hashPassword(newKey));
  res.json({ ok: true });
});

// ================= per-event member management =================
// Viewing and ADDING members is open to admins and to employees of that
// specific event (so employees can build their own event team). Changing
// an existing member's role or removing them stays admin-only.
// These routes take the event id from the URL itself, not x-event-id.
function requireEventRoleByParam(minRole) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      const event = getEvent(req.params.id);
      if (!event) return res.status(404).json({ error: 'event not found' });
      if (!userHasEventAccess(req.user, event.id, minRole)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
      }
      req.event = event;
      next();
    });
  };
}
app.get('/api/events/:id/members', requireEventRoleByParam('employee'), (req, res) => {
  res.json(listEventMembers(req.event.id));
});
app.post('/api/events/:id/members', requireEventRoleByParam('employee'), (req, res) => {
  const { userId, role } = req.body || {};
  if (!['employee', 'scanner'].includes(role)) return res.status(400).json({ error: 'role must be employee or scanner' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'That person is not in Team Details yet - add them there first' });
  addOrUpdateEventMember(req.event.id, userId, role);
  res.json({ ok: true });
});
app.patch('/api/events/:id/members/:userId', requireAdmin, (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'event not found' });
  const { role } = req.body || {};
  if (!['employee', 'scanner'].includes(role)) return res.status(400).json({ error: 'role must be employee or scanner' });
  addOrUpdateEventMember(event.id, req.params.userId, role);
  res.json({ ok: true });
});
app.delete('/api/events/:id/members/:userId', requireAdmin, (req, res) => {
  removeEventMember(req.params.id, req.params.userId);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Gatekeep server running on http://localhost:${PORT}`));
}
module.exports = app;
