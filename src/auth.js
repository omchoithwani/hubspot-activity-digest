'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET must be set in production.');
  process.exit(1);
}
const SECRET = JWT_SECRET || 'insecure-dev-secret-change-before-deploying';

const COOKIE_NAME = 'session';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  secure: process.env.NODE_ENV === 'production',
};

function signToken(userId, email) {
  return jwt.sign({ id: userId, email }, SECRET, { expiresIn: '30d' });
}

function setSessionCookie(res, userId, email) {
  res.cookie(COOKIE_NAME, signToken(userId, email), COOKIE_OPTIONS);
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Middleware: verifies JWT cookie, sets req.user = { id, email }
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login');
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (_) {
    clearSessionCookie(res);
    return res.redirect('/login');
  }
}

// Middleware: fetches full user row from DB, sets req.dbUser
// Must run after requireAuth
function loadUser(req, res, next) {
  const { getUserById } = require('./db');
  getUserById(req.user.id)
    .then((user) => {
      if (!user) {
        clearSessionCookie(res);
        return res.redirect('/login');
      }
      req.dbUser = user;
      next();
    })
    .catch(next);
}

// Middleware: blocks access if trial expired and no active subscription
// Must run after loadUser
function requireSubscription(req, res, next) {
  const user = req.dbUser;
  const status = user.subscription_status;

  if (status === 'active' || status === 'lifetime') return next();

  if (status === 'trial') {
    const trialEnd = new Date(user.trial_ends_at + ' UTC');
    if (Date.now() < trialEnd.getTime()) return next();
  }

  // Trial expired or subscription cancelled
  return res.redirect('/billing?expired=1');
}

// Returns days remaining in trial (0 if expired/not on trial)
function trialDaysLeft(user) {
  if (user.subscription_status !== 'trial') return 0;
  const trialEnd = new Date(user.trial_ends_at + ' UTC');
  const ms = trialEnd.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

module.exports = {
  signToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  loadUser,
  requireSubscription,
  trialDaysLeft,
};
