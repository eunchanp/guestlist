# Guestlist

A phone-first guest list: collect names before the event, check guests in at
the door, export to CSV at any time. Vanilla HTML/CSS/JS, no build step,
Supabase backend (the same project as qplex, tables prefixed `guestlist_`).

## Setup (once)

1. Open the Supabase SQL editor for the qplex project and run `db/schema.sql`.
2. In the same editor, set the edit password:
   ```sql
   select guestlist_set_password('your-password');
   ```
   Run it again any time to change the password. Devices that remembered the
   old one are asked for the new one on their next edit.

Viewing the list needs no password. Adding, editing, deleting and checking
guests in all go through password-checked database functions, so the anon key
in `js/config.js` can't modify anything on its own.

## Using it

- **Before the event:** Unlock, tap **Add guests**, paste names one per line.
  Duplicates (ignoring case and accents) are flagged and skipped.
- **At the door:** type a few letters of the name and tap the row to check them
  in. The search clears for the next guest, and **Undo** is in the toast.
  - Enter checks in the match when only one person who hasn't arrived matches.
  - Tapping someone who already arrived warns you instead of undoing it.
  - A name that isn't on the list can be added and checked in from the search
    results (walk-ins).
  - Several door phones stay in sync live.
- **Export:** the **CSV** button downloads everyone with their status and
  arrival time.

## Local development

Serve over HTTP: `python3 -m http.server 8124`, then open
`http://localhost:8124`.

| URL | Data |
| --- | --- |
| `localhost` (default) | single-device **demo** (localStorage, password `demo`) |
| `localhost/?env=live` | the real Supabase list |
| any URL with `?demo=1` | demo |
| deployed site | the real Supabase list |
