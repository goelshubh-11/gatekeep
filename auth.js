const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SECRET = process.env.JWT_SECRET;

// Normal login session (12h)
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, isAdmin: !!user.is_admin },
    SECRET,
    { expiresIn: '12h' }
  );
}

// Short-lived token issued right after OTP verification, only good for
// the one "set your password" step of signup - not a login session.
function signSignupToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, purpose: 'set-password' },
    SECRET,
    { expiresIn: '15m' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (e) {
    return null;
  }
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}
function checkPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

module.exports = { signToken, signSignupToken, verifyToken, hashPassword, checkPassword };
