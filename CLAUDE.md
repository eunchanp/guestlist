# CLAUDE.md - Guestlist

Phone-first guest list (collect names → check in at the door → CSV export).
Zero-build vanilla JS; see README.md for user-facing setup.

## Architecture
- `index.html` markup, `css/styles.css` (tokens in `:root`, dark mode via
  `prefers-color-scheme`), `js/app.js` all logic, `js/config.js` public
  Supabase URL + anon key (shared with qplex), `db/schema.sql` idempotent schema.
- **Security:** `guestlist_guests` is public-read (RLS select policy) with no
  write grants. All writes go through `security definer` RPCs
  (`guestlist_add/update/set_arrived/delete`, `guestlist_verify`) that check the
  password against a bcrypt hash in `guestlist_secret` (no client access).
  `guestlist_set_password` / `guestlist_require` are not executable by
  anon/authenticated. The password is never in the repo; the client keeps the
  verified password in localStorage (`gl_pw`, demo uses `gl_demo_pw`) and sends
  it with each RPC. SQLSTATE `28P01` = wrong password → client locks and re-prompts.
- **Stores:** `createSupabaseStore` / `createLocalStore` share one interface
  (`init, fetchAll, verify, add, update, setArrived, remove, subscribe`).
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
