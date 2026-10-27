# CLAUDE.md - Guestlist

Phone-first guest list (collect names → check in at the door → CSV export).
Zero-build vanilla JS; see README.md for user-facing setup.

## Architecture
- `index.html` markup, `css/styles.css` (tokens in `:root`, dark mode via
  `prefers-color-scheme`), `js/app.js` all logic, `js/config.js` public
  Supabase URL + anon key (shared with qplex), `db/schema.sql` idempotent schema,
  `api/session.js` the only server code (Vercel function, sets the unlock cookie).
- **Security:** `guestlist_guests` is public-read (RLS select policy) with no
  write grants. All writes go through `security definer` RPCs
  (`guestlist_add/update/set_arrived/delete`) whose `p_password` takes the
  device token or the password, checked against a bcrypt hash in
  `guestlist_secret` (no client access). `guestlist_login` trades the password
  for the device token = HMAC of that hash, so changing the password revokes
  every device. `guestlist_set_password` / `guestlist_require` /
  `guestlist_device_token` are not executable by anon/authenticated. The
  password is never in the repo or stored on devices. SQLSTATE `28P01` = bad
  credential → client locks and re-prompts.
- **Staying unlocked:** the token lives in cookie `gl_token` (demo
  `gl_demo_token`), Path = the app's directory (`/guestlist/` on eunchan.me),
  400 days. `saveToken()` POSTs it to `api/session` so the server sets it:
  Safari caps cookies written by `document.cookie` at 7 days and clears
  localStorage after 7 days without a visit. Without the endpoint it falls back
  to `document.cookie`; never rewrite an existing server-set cookie from JS.
  Older builds stored the password in localStorage (`gl_pw` / `gl_demo_pw`);
  `upgradeLegacyPassword()` trades it for a token at boot.
- **Stores:** `createSupabaseStore` / `createLocalStore` share one interface
  (`init, fetchAll, login, add, update, setArrived, remove, subscribe`).
  `pickStore()`: localhost → demo unless `?env=live`; `?demo=1` forces demo.
- **State:** `state.guests` Map. Writes are optimistic (`_pending` rows, `tmp-`
  ids for inserts) via `mutate(fn, rollback, failMsg)`. Realtime events upsert/
  delete incrementally; full `refetch()` on reconnect, tab focus and `online`.
- **Door UX rules:** row tap checks in; tapping an arrived guest warns (never
  silently un-checks); check-in from a search clears + refocuses the search;
  Enter checks in a single waiting match; walk-in add row under results.

## Verify
- Schema: tested in PGlite with stubbed `anon`/`authenticated` roles and a
  `supabase_realtime` publication (see git history / ask). Keep it idempotent.
- UI: `python3 -m http.server 8124`, demo mode, drive it in the browser at
  phone width (390px) in light and dark.
- Unlock cookie: python can't run `api/session.js` (POST → 501, JS fallback).
  To exercise the server-set path, serve the app under `/guestlist/` with a
  small Node server that calls the handler with `req.body` parsed (as Vercel does).
