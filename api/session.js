'use strict';
/* ============================================================
   POST /api/session - Vercel function that stores the device token
   (from guestlist_login) as a cookie set by the server.

   Why a server: Safari expires cookies written by JavaScript after 7
   days and clears localStorage after 7 days without a visit. Cookies
   from an HTTP response are exempt, so an unlocked phone stays unlocked
   between events. The cookie is not HttpOnly because the app reads the
   token to sign its RPCs; it only ever holds the token, never the
   password. Without this endpoint (local dev) the app sets it from JS.
   ============================================================ */

const NAMES = new Set(['gl_token', 'gl_demo_token']);
const MAX_AGE = 400 * 24 * 60 * 60; // the longest browsers keep a cookie

module.exports = (req, res) => {
  const send = (status) => {
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  };
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(405);
  }
  // Only the app itself may set it: no planting cookies from other sites.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return send(403);

  const { name, value, path } = req.body || {};
  if (!NAMES.has(name) || !/^[\w-]{1,128}$/.test(value) || !/^\/([\w-]+\/)*$/.test(path)) return send(400);
  res.setHeader('Set-Cookie', `${name}=${value}; Path=${path}; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`);
  send(204);
};
