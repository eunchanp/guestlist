# CLAUDE.md - Guestlist

Context for working in this repo without re-reading everything. Keep it current
when the architecture changes. `README.md` is the user-facing setup and usage
guide; this file is for agents.

## What this is
A phone-first guest list for a real event door: collect names before the
event, check guests in at the door (several phones at once, synced live),
export to CSV. Anyone with the link can view; editing needs the password.
There is one list and no "event" concept: **Clear list** wipes it for the next event.

## Operational facts that change how you work
- **Its own repo and deploy.** Git remote `eunchanp/guestlist` (`main`), its own
  Vercel project (`guestlist-livid.vercel.app`). `eunchan.me/guestlist/` is a
  rewrite in the parent site repo (`../../site/vercel.json`, repo
  `eunchanp/eunchan`, which git-ignores `projects/`). Commit here, not in the parent.
- **No build step.** Vercel serves the static files as they are, plus
  `api/session.js` as a function. Only commit or push when asked.
- **The live DB is shared with qplex** (the lifeguard app next door): Supabase
  project ref `wgomdozqtsmgjddjpzwr`. Only ever touch `guestlist_*` objects.
  Treat it as production. If Supabase MCP tools are available, use them read-only
  unless the owner asks otherwise.
- **Schema changes ship by hand.** The owner pastes `db/schema.sql` into the
  Supabase SQL editor. It must stay idempotent and be run *before* the app code
  that needs it deploys; say so in the commit message ("Run db/schema.sql
  before deploying this.").
- **Secrets.** `js/config.js` holds the public anon key (committed, safe). Never
  put the service_role key anywhere client-side. The edit password is never in
  the repo or on devices; the owner sets it with
  `select guestlist_set_password('...')` in the SQL editor.
- **Localhost never touches real guests** unless you add `?env=live` (red
  "LIVE DB" badge). Don't use it for testing.

## Files
- `index.html` - all markup: header (brand, `#envBadge`, `#conn` pill, CSV and
  lock buttons, progress, `#search`, filter tabs), `#banner`, `#list` /
  `#empty` / `#listFoot`, FAB `#addBtn`, four sheets (`#unlockModal`,
  `#addModal`, `#editModal`, `#clearModal`), `#toastWrap`. Loads
  `js/config.js`, then `js/app.js` (plain scripts, no modules).
- `css/styles.css` - one file, sections marked `/* ---------- name ---------- */`.
  Tokens in `:root`, dark values in the `prefers-color-scheme: dark` block below it.
- `js/app.js` - all logic, sections marked `// ---------- name ----------` in
  this order: helpers, storage: Supabase, storage: local demo, state, search,
  rendering, toasts, data sync, actions, lock / unlock, modals, CSV export,
  wiring; then `pickStore()`, `boot()`, `main()`. Find things by function name.
- `js/config.js` - `window.SUPABASE_URL` / `window.SUPABASE_ANON_KEY`.
- `db/schema.sql` - tables, RLS, functions, grants, realtime publication.
- `api/session.js` - the only server code (sets the unlock cookie).
- `dev/` - local tooling, never loaded by the app: `test-schema.mjs` (schema
  test in PGlite), `serve.cjs` (production-like local server), and a
  `package.json` pinning PGlite (`node_modules/` is git-ignored).
- `.claude/launch.json` - preview configs `static` (python, port 8124) and
  `vercel-local` (`dev/serve.cjs`, opens `http://127.0.0.1:8126`), both autoPort.

## Data model
- `guestlist_guests`: `id uuid`, `name` (trimmed, 1-200 chars), `note`
  (default `''`, max 500), `arrived_at timestamptz` (null = not arrived),
  `created_at`, `updated_at`. Index on `lower(name)`.
- `guestlist_secret`: one row (`id = 1`) with the bcrypt `password_hash`.
  No policies and no grants, so clients can't see it at all.
- Client-only row flags: `_pending` (write in flight, row shown dimmed) and
  `_new` (optimistic insert with a `tmp-` id, left out of the CSV).

## Security model and RPC API
`guestlist_guests` is public-read (RLS select policy) with no write grants.
Every write goes through a `security definer` RPC whose `p_password` takes the
device token or the password, checked by `guestlist_require` against the hash
in `guestlist_secret`. The device token is an HMAC of the password hash, so
changing the password revokes every device. The token is checked before
bcrypt, so token writes skip the slow check (0.2 ms vs 48 ms).

| RPC | Args after `p_password` | Returns | Notes |
| --- | --- | --- | --- |
| `guestlist_login` | (none) | token, or null | null = wrong password |
| `guestlist_add` | `p_names text[], p_note, p_arrived` | new rows | skips blank names, keeps order |
| `guestlist_update` | `p_id, p_name, p_note` | row | |
| `guestlist_set_arrived` | `p_id, p_arrived, p_at` | row | `p_at` restores an exact time (Undo), else server `now()` |
| `guestlist_delete` | `p_id` | void | |
| `guestlist_clear` | (none) | count deleted | `delete ... where true` |

Internal and not executable by `anon`/`authenticated`: `guestlist_set_password`,
`guestlist_require`, `guestlist_device_token`.

Errors carry a Postgres SQLSTATE in `.code` (`StoreError`). The demo store
throws the same codes, so every UI path works in demo:
- `28P01` bad password or token → `mutate()` locks and reopens the unlock
  sheet ("The password has changed").
- `28000` password not set → the unlock sheet says to run `guestlist_set_password`.
- `P0002` guest not found (removed on another device) → toast + `refetch()`.
- `42P01` / `PGRST205` → "Database not set up" banner.

## Staying unlocked (token cookie)
- The token lives in cookie `gl_token` (demo `gl_demo_token`), Path = the
  app's directory (`COOKIE_PATH`, `/guestlist/` on eunchan.me), 400 days.
  `pickStore()` reads it into `state.token` at boot.
- `saveToken()` POSTs it to `api/session` so the server sets it: Safari caps
  cookies written by `document.cookie` at 7 days and clears localStorage after
  7 days without a visit. Without the endpoint it falls back to
  `document.cookie`. Never rewrite an existing server-set cookie from JS.
- `api/session.js` accepts only the two cookie names, a `[\w-]{1,128}` value
  and a directory path like `/guestlist/`, and rejects any `Sec-Fetch-Site` other than
  `same-origin`. It is not HttpOnly on purpose: the app reads the token to sign RPCs.
- Older builds stored the password in localStorage (`gl_pw` / `gl_demo_pw`);
  `upgradeLegacyPassword()` trades it for a token at boot.
- `lock()` deletes the cookie and closes any open sheet.

## Client architecture (`js/app.js`)
- **Stores:** `createSupabaseStore` / `createLocalStore` share one interface
  (`init, fetchAll, login, add, update, setArrived, remove, clear, subscribe`).
  A new write must be added to both.
  - Supabase: lazy-loads supabase-js 2.45.4 (UMD from jsdelivr) in `init()`,
    so demo mode works offline. `persistSession: false`.
  - Demo: localStorage `gl_demo_guests`, seeded with 28 guests on first run,
    120 ms fake latency (`later()`), password `demo`, token `demo-device-token`.
    The `storage` event from other tabs stands in for other door phones.
- **`pickStore()`:** demo if `?demo` is present, the config is missing, or the
  host is `localhost` / `127.0.0.1` / file without `?env=live`. It also sets
  the env badge and picks the cookie and legacy key names.
- **State:** `state` holds `guests` (Map id → row), `query`, `filter` (saved
  in `gl_filter`), `token`, `loaded`, `live` (realtime up), `online`,
  `editingId`. At module level: `store`, `isDemo`, `flashId` (row to pulse
  after a check-in, cleared by the next render).
- **Rendering:** `render()` recomputes everything and rewrites `#list` with
  `innerHTML` every time. There is no diffing. Always `esc()` user text that
  goes into HTML, including toast messages, which are HTML.
- **Events:** one delegated `document` click listener in `wire()` dispatches
  on data attributes (`data-toggle`, `data-edit`, `data-walkin`,
  `data-addname`, `data-showall`, `data-retry`, `data-export`,
  `data-edit-arrive`, `data-close`, backdrop). Buttons injected by `render()`
  use a data attribute handled there. Static buttons get a direct listener in `wire()`.
- **Writes are optimistic:** snapshot, put the optimistic row with `_pending`,
  `render()`, then `await mutate((token) => store.x(token, ...), rollback, failMsg)`.
  On success swap in the server row and render again. `mutate` returns
  `undefined` on failure and already shows the right message (auth, not found,
  offline), so callers only check the result.
- **Sync:** realtime `postgres_changes` → `applyEvent()` (upsert/delete,
  ignoring echoes for rows still `_pending`). `refetch()` (60 ms debounce) runs
  on realtime reconnect, `visibilitychange` and `online`, and keeps in-flight
  optimistic rows. A 60 s interval re-renders so arrival times gain a date
  after midnight.
- **Search:** `norm()` (strip accents, lowercase, collapse spaces) drives
  search, duplicate detection and the clear phrase. `matchScore()` needs every
  query word to hit: name prefix 4, word prefix 3, substring 1, note 0.5. No
  query: Arrived tab sorts most recent first, otherwise by name
  (`Intl.Collator`, numeric). `highlight()` maps `<mark>` back onto accented characters.
- **Sheets and toasts:** `.overlay > form.sheet`; `openModal(sel, focusSel)` /
  `closeModal(sel)` restore focus, and Escape or a backdrop tap closes.
  `toast(html, { action, onAction, kind, ms })` shows one toast at a time;
  kinds `''`, `success`, `warn`, `error`.

## Door UX rules (don't regress these)
- Row tap checks in; when locked it opens the unlock sheet instead.
- Tapping an arrived guest warns (buzz, shake, "Mark not arrived" action) and
  never silently un-checks.
- Check-in from a search clears the search and scrolls to top. It refocuses
  the search only if the keyboard was used in the last 60 s.
- Enter checks in when exactly one *waiting* guest matches; otherwise it blurs
  to dismiss the phone keyboard.
- Walk-ins (unlocked, and only when no guest has exactly that `norm` name): under real
  matches, one quiet "Not listed? Add X & check in" row; with no matches,
  "Add X & check in" plus "Add to list only".
- Every check-in toast has Undo. `/` focuses search from anywhere.
- Add sheet: one name per line, duplicates (against the list and within the
  paste) flagged and skipped, Cmd/Ctrl+Enter submits.
- Delete is a two-tap arm in the edit sheet. **Clear list** shows only under
  the full, unfiltered, unsearched list (never in the door flow). It needs
  `CLEAR_PHRASE` typed (compared with `norm`, so case and spacing are
  forgiven) and offers a CSV export first.
- CSV: UTF-8 BOM for Excel, formula-injection guard in `csvCell()` (but `+1` /
  `-2` notes stay readable), sorted by name.

## Conventions and gotchas
- Vanilla JS, no dependencies besides supabase-js, no bundler, no modules.
  `dev/` has its own `package.json` for test tooling; the app never depends on it.
- UI copy is short and plain, with curly apostrophes and quotes (`Couldn’t`,
  `“name”`) and `…`. Never an em dash; use a plain `-`.
- Comments explain *why*, briefly, above the code. File headers are `/* ===== */` blocks.
- CSS: use tokens. A new color needs a light value in `:root` *and* a dark
  value in the dark block (text on `--danger` uses `--on-danger`). Mobile
  first; breakpoints at 380, 400, 600 and 760 px; respect `safe-area-inset-*`.
- SQL functions are `security definer` with `set search_path = ''`, so qualify
  every name (`public.guestlist_guests`, `extensions.crypt`).
- Postgres grants EXECUTE to PUBLIC on create, and Supabase's default
  privileges also grant `anon` / `authenticated` everything on new tables and
  functions in `public`. So every new function needs `revoke all ... from public`
  plus `grant execute ... to anon, authenticated` (client API), or
  `revoke all ... from public, anon, authenticated` (internal). Keep these
  lines in the block at the end of the functions. The schema test fails if
  clients can execute anything outside its `CLIENT_API` list.
- Changing a function's arguments or return type: `drop function if exists`
  the old signature first. `create or replace` can't change the return type,
  and a new argument list creates an overload.
- Supabase's pg_safeupdate rejects DELETE/UPDATE without WHERE (hence
  `where true`). Use DELETE, not TRUNCATE, so realtime tells the other devices.
- Storage keys: cookies `gl_token` / `gl_demo_token`; localStorage
  `gl_filter`, `gl_demo_guests`, legacy `gl_pw` / `gl_demo_pw`. Go through
  `lsGet` / `lsSet` (they survive private mode).

## Recipe: add a write operation
1. `db/schema.sql`: a `security definer` function that starts with
   `perform public.guestlist_require(p_password);`, plus its revoke/grant lines.
2. `dev/test-schema.mjs`: add the function to `CLIENT_API` and add a test
   for what it does and that a wrong token gets `28P01`. Run `npm test` in `dev/`.
3. `createSupabaseStore`: `x: (token, ...) => rpc('guestlist_x', { p_password: token, ... })`.
4. `createLocalStore`: the same method, `check(token)` first, the same error
   codes, result through `later()`.
5. An action using the optimistic + `mutate()` pattern; wire its UI in `wire()`.
6. Update README.md if users will notice it, and put the schema note in the commit message.

## Run and verify
- **UI:** `preview_start` with `static`, or `python3 -m http.server 8124`.
  Localhost is demo mode (password `demo`). Drive it at phone width (390 px) in
  light and dark. To reset demo data run
  `localStorage.removeItem('gl_demo_guests')` and reload. Two tabs on the same
  origin stand in for two door phones.
- **Ports and cookies:** other sessions may already be serving on 8124/8125,
  so check `lsof -iTCP -sTCP:LISTEN` before trusting a response. Cookies
  ignore ports: a demo token set by any `localhost` server with `Path=/`
  unlocks every `localhost` port. Use `127.0.0.1` for a clean cookie jar.
- **Schema:** `cd dev && npm install` once, then `npm test` after any change
  to `db/schema.sql`. It runs the schema twice in PGlite (in-memory Postgres)
  with Supabase's roles, default grants and realtime publication stubbed, then
  checks every RPC as `anon`, the refusals (`42501`, `28P01`), password
  rotation, that a re-run keeps the data, and that only `CLIENT_API` is
  executable. Tests share one database and run in order. To try a variant
  without touching the real file, run `node test-schema.mjs <path-to-sql>`.
- **Unlock cookie, server path:** python answers `POST api/session` with 501,
  so the app falls back to a JS cookie. For the real path, `preview_start`
  with `vercel-local` (or `node dev/serve.cjs`, with `PORT` to override 8126).
  It serves the app under `/guestlist/` like eunchan.me and runs
  `api/session.js` with a parsed `req.body` like Vercel. Unlock, then
  `await cookieStore.get('gl_demo_token')` should give `secure: true`, path
  `/guestlist/` and an expiry 400 days out. The JS fallback over http has no
  Secure flag. The browser may list the 204 as `ERR_ABORTED`, which is harmless.
