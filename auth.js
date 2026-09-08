const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;

function requireSecret() {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is not set. Add it in your Vercel project settings.');
  }
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
async function verifyPassword(pw, hash) {
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

// Security-question answers are normalized (trimmed + lowercased) before
// hashing so capitalization or stray whitespace at reset time doesn't fail
// an otherwise-correct answer.
function normalizeAnswer(answer) {
  return String(answer || '').trim().toLowerCase();
}
async function hashAnswer(answer) {
  return hashPassword(normalizeAnswer(answer));
}
async function verifyAnswer(answer, hash) {
  if (!hash) return false;
  return bcrypt.compare(normalizeAnswer(answer), hash);
}

function makeToken(user) {
  requireSecret();
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function readToken(req) {
  try {
    requireSecret();
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    if (!auth) return null;
    const token = auth.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = {
  hashPassword, verifyPassword,
  normalizeAnswer, hashAnswer, verifyAnswer,
  makeToken, readToken
};
