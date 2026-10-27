'use strict';
/* ============================================================
   Guestlist - collect names before the event, check guests in at
   the door, export to CSV. Vanilla JS, no build step.

   Reads are public; every write goes through a password-checked
   Supabase RPC (see db/schema.sql). Unlocking trades the password for
   a device token, which the device keeps in a long-lived cookie.
   ============================================================ */

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Case-, accent- and whitespace-insensitive form used for search + duplicate checks.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const byName = (a, b) => collator.compare(a.name, b.name);
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };
const buzz = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* unsupported */ } };
const cookieGet = (name) => {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
};
const cookieSet = (name, value, maxAge) => {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; SameSite=Lax${secure}`;
};

// The device token lives in a cookie (demo: gl_demo_token). Older builds kept
// the password itself in localStorage (gl_pw / gl_demo_pw); boot() trades it in.
let tokenCookie = 'gl_token';
let legacyPwKey = 'gl_pw';
const COOKIE_PATH = new URL('.', location.href).pathname; // /guestlist/ on eunchan.me
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // the longest browsers keep a cookie
const FILTER_KEY = 'gl_filter';
const DEMO_PASSWORD = 'demo';
const DEMO_TOKEN = 'demo-device-token';
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';

function fmtTime(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

// Errors carry a Postgres SQLSTATE in .code (28P01 = wrong password).
class StoreError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const isAuthError = (e) => e && e.code === '28P01';

// ---------- storage: Supabase ----------
function loadSupabaseLib() {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve();
    const s = document.createElement('script');
    s.src = SUPABASE_LIB;
    s.onload = resolve;
    s.onerror = () => reject(new StoreError('Could not load the Supabase library. Check your connection.'));
    document.head.appendChild(s);
  });
}

// Write RPCs take the device token in p_password (the password itself works too).
function createSupabaseStore() {
  let sb = null;
  const rpc = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new StoreError(error.message, error.code);
    return data;
  };
  return {
    async init() {
      await loadSupabaseLib();
      sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    },
    async fetchAll() {
      const { data, error } = await sb.from('guestlist_guests').select('*');
      if (error) throw new StoreError(error.message, error.code);
      return data || [];
    },
    // Resolves to the device token, or null for a wrong password.
    login: (pw) => rpc('guestlist_login', { p_password: pw }),
    add: (token, names, note, arrived) =>
      rpc('guestlist_add', { p_password: token, p_names: names, p_note: note, p_arrived: arrived }),
    update: (token, id, name, note) =>
      rpc('guestlist_update', { p_password: token, p_id: id, p_name: name, p_note: note }),
    setArrived: (token, id, arrived, at = null) =>
      rpc('guestlist_set_arrived', { p_password: token, p_id: id, p_arrived: arrived, p_at: at }),
    remove: (token, id) => rpc('guestlist_delete', { p_password: token, p_id: id }),
    // onEvent({type, row|id}); onStatus(true|false) as the realtime link goes up/down.
    subscribe(onEvent, onStatus) {
      sb.channel('guestlist')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'guestlist_guests' }, (p) => {
          if (p.eventType === 'DELETE') onEvent({ type: 'delete', id: p.old && p.old.id });
          else onEvent({ type: 'upsert', row: p.new });
        })
        .subscribe((status) => onStatus(status === 'SUBSCRIBED'));
    },
  };
}

// ---------- storage: local demo (single device, no network) ----------
function createLocalStore() {
  const KEY = 'gl_demo_guests';
  const read = () => { try { return JSON.parse(lsGet(KEY) || '[]'); } catch { return []; } };
  const write = (rows) => lsSet(KEY, JSON.stringify(rows));
  const check = (token) => {
    if (token !== DEMO_TOKEN && token !== DEMO_PASSWORD) throw new StoreError('invalid password', '28P01');
  };
  const now = () => new Date().toISOString();
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 120)); // feel like a network call
  const SEED = ['Ava Thompson', 'Benjamin Carter', 'Chloé Dubois', 'Daniel Kim', 'Elena Rossi',
    'Felix Wagner', 'Grace Okafor', 'Hiro Tanaka', 'Isabella Martínez', 'Jack Murphy',
    'Kai Nakamura', 'Liam O\'Brien', 'Maya Patel', 'Noah Fischer', 'Olivia Brown', 'Priya Shah',
    'Quinn Rivera', 'Rosa Alvarez', 'Samuel Lee', 'Tara Singh', 'Umar Haddad', 'Victoria Chen',
    'William Scott', 'Ximena Torres', 'Yusuf Demir', 'Zoe Laurent', 'Daniel Kimball', 'Ana Lima'];
  return {
    async init() {
      if (lsGet(KEY) == null) {
        write(SEED.map((name, i) => ({
          id: crypto.randomUUID(), name, note: i % 7 === 0 ? '+1' : (i % 11 === 0 ? 'VIP' : ''),
          arrived_at: i % 4 === 1 ? new Date(Date.now() - i * 60000).toISOString() : null,
          created_at: now(), updated_at: now(),
        })));
      }
    },
    fetchAll: async () => read(),
    login: async (pw) => later(pw === DEMO_PASSWORD ? DEMO_TOKEN : null),
    async add(token, names, note, arrived) {
      check(token);
      const rows = names.map((n) => n.trim()).filter(Boolean).map((name) => ({
        id: crypto.randomUUID(), name, note: (note || '').trim(),
        arrived_at: arrived ? now() : null, created_at: now(), updated_at: now(),
      }));
      write([...read(), ...rows]);
      return later(rows);
    },
    async update(token, id, name, note) {
      check(token);
      const rows = read();
      const r = rows.find((x) => x.id === id);
      if (!r) throw new StoreError('guest not found', 'P0002');
      Object.assign(r, { name: name.trim(), note: (note || '').trim(), updated_at: now() });
      write(rows);
      return later({ ...r });
    },
    async setArrived(token, id, arrived, at = null) {
      check(token);
      const rows = read();
      const r = rows.find((x) => x.id === id);
      if (!r) throw new StoreError('guest not found', 'P0002');
      Object.assign(r, { arrived_at: arrived ? (at || now()) : null, updated_at: now() });
      write(rows);
      return later({ ...r });
    },
    async remove(token, id) {
      check(token);
      write(read().filter((x) => x.id !== id));
      return later(null);
    },
    subscribe(onEvent, onStatus) {
      onStatus(true);
      // Other tabs on this device stand in for "other door phones".
      window.addEventListener('storage', (e) => { if (e.key === KEY) refetch(); });
    },
  };
}

// ---------- state ----------
const state = {
  guests: new Map(),       // id -> row
  query: '',
  filter: ['all', 'waiting', 'arrived'].includes(lsGet(FILTER_KEY)) ? lsGet(FILTER_KEY) : 'all',
  token: null,             // device token (or a legacy password); set in pickStore()
  loaded: false,
  live: false,             // realtime link up
  online: navigator.onLine,
  editingId: null,
};
let store = null;
let isDemo = false;
let flashId = null;        // row to pulse after a check-in

const unlocked = () => !!state.token;
const allGuests = () => [...state.guests.values()];
const findByName = (name) => {
  const n = norm(name);
  return allGuests().filter((g) => norm(g.name) === n);
};

// ---------- search ----------
// Every query word must hit the name (or the note). Prefix hits rank above
// substring hits, so "jo" puts "John" above "Marjorie".
function matchScore(g, words) {
  const name = norm(g.name);
  const parts = name.split(' ');
  const note = norm(g.note);
  let score = 0;
  for (const w of words) {
    if (name.startsWith(w)) score += 4;
    else if (parts.some((p) => p.startsWith(w))) score += 3;
    else if (name.includes(w)) score += 1;
    else if (note.includes(w)) score += 0.5;
    else return 0;
  }
  return score;
}

function visibleGuests() {
  let rows = allGuests();
  if (state.filter === 'waiting') rows = rows.filter((g) => !g.arrived_at);
  else if (state.filter === 'arrived') rows = rows.filter((g) => g.arrived_at);
  const q = norm(state.query);
  if (!q) {
    // The Arrived tab reads like a door log: most recent first.
    if (state.filter === 'arrived') return rows.sort((a, b) => b.arrived_at.localeCompare(a.arrived_at));
    return rows.sort(byName);
  }
  const words = q.split(' ');
  return rows
    .map((g) => ({ g, s: matchScore(g, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || byName(a.g, b.g))
    .map((x) => x.g);
}

// ---------- rendering ----------
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';
const ICON_UNLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

function highlight(name) {
  const words = norm(state.query).split(' ').filter(Boolean);
  if (!words.length) return esc(name);
  // Map each char of the normalized name back to the original so accents still highlight.
  const chars = [...name];
  const folded = chars.map((c) => norm(c) || ' ');
  const flat = folded.join('');
  const mark = new Array(chars.length).fill(false);
  for (const w of words) {
    let i = flat.indexOf(w);
    // Prefer a word-start hit, matching the ranking.
    for (let j = i; j !== -1; j = flat.indexOf(w, j + 1)) {
      if (j === 0 || flat[j - 1] === ' ') { i = j; break; }
    }
    if (i === -1) continue;
    let pos = 0;
    for (let k = 0; k < chars.length; k++) {
      const len = folded[k].length;
      if (pos + len > i && pos < i + w.length) mark[k] = true;
      pos += len;
    }
  }
  let out = '';
  let open = false;
  chars.forEach((c, k) => {
    if (mark[k] && !open) { out += '<mark>'; open = true; }
    if (!mark[k] && open) { out += '</mark>'; open = false; }
    out += esc(c);
  });
  return out + (open ? '</mark>' : '');
}

function guestRow(g) {
  const arrived = !!g.arrived_at;
  const sub = [];
  if (g.note) sub.push(`<span class="g-note">${esc(g.note)}</span>`);
  if (arrived) sub.push(`<span class="g-time">Arrived ${esc(fmtTime(g.arrived_at))}</span>`);
  const cls = ['guest', arrived ? 'arrived' : '', g._pending ? 'pending' : '', g.id === flashId ? 'flash' : '']
    .filter(Boolean).join(' ');
  return `<li class="${cls}" data-id="${esc(g.id)}">
    <button type="button" class="g-main" data-toggle aria-pressed="${arrived}"
      aria-label="${esc(g.name)}${arrived ? ', arrived' : ', not arrived'}">
      <span class="g-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>
      <span class="g-text">
        <span class="g-name">${highlight(g.name)}</span>
        ${sub.length ? `<span class="g-sub">${sub.join('<span class="dot">·</span>')}</span>` : ''}
      </span>
    </button>
    ${unlocked() ? `<button type="button" class="g-edit" data-edit aria-label="Edit ${esc(g.name)}">${ICON_EDIT}</button>` : ''}
  </li>`;
}

function addRows(q, hasMatches) {
  // Walk-ins: a searched name can be added (and checked in) without leaving the search.
  // Under real matches it shrinks to one quiet row so it never competes with them.
  if (hasMatches) {
    return `<li class="add-row"><button type="button" class="add-btn" data-walkin>${ICON_PLUS}<span>Not listed? Add <b>${esc(q)}</b> &amp; check in</span></button></li>`;
  }
  return `<li class="add-row">
    <button type="button" class="add-btn primary" data-walkin>${ICON_PLUS}<span>Add <b>${esc(q)}</b> &amp; check in</span></button>
    <button type="button" class="add-btn" data-addname>${ICON_PLUS}<span>Add to list only</span></button>
  </li>`;
}

function render() {
  const all = allGuests();
  const arrived = all.filter((g) => g.arrived_at).length;
  $('#arrivedCount').textContent = arrived;
  $('#totalCount').textContent = all.length;
  $('#progressFill').style.width = all.length ? `${(arrived / all.length) * 100}%` : '0';
  $('#fAll').textContent = all.length;
  $('#fWaiting').textContent = all.length - arrived;
  $('#fArrived').textContent = arrived;
  $$('.filter').forEach((b) => {
    const on = b.dataset.filter === state.filter;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });

  const lockBtn = $('#lockBtn');
  lockBtn.innerHTML = unlocked() ? `${ICON_UNLOCK}<span class="icon-btn-label">Lock</span>` : `${ICON_LOCK}<span class="icon-btn-label">Unlock</span>`;
  lockBtn.classList.toggle('accent', !unlocked());
  lockBtn.setAttribute('aria-label', unlocked() ? 'Lock editing on this device' : 'Unlock editing');
  $('#addBtn').hidden = !unlocked() || !state.loaded;
  document.body.classList.toggle('is-unlocked', unlocked());

  renderConn();
  if (!state.loaded) return;

  const rows = visibleGuests();
  const q = state.query.trim();
  const showAdd = unlocked() && q && !findByName(q).length;
  $('#list').innerHTML = rows.map(guestRow).join('') + (showAdd && rows.length ? addRows(q, true) : '');
  flashId = null;

  const empty = $('#empty');
  if (rows.length) { empty.hidden = true; return; }
  empty.hidden = false;
  if (!all.length) {
    empty.innerHTML = unlocked()
      ? '<p class="empty-title">No guests yet</p><p>Tap <b>Add guests</b> to start the list.</p>'
      : '<p class="empty-title">No guests yet</p><p>Unlock to start adding names.</p>';
  } else if (q) {
    const elsewhere = state.filter !== 'all' && allGuests().some((g) => matchScore(g, norm(q).split(' ')) > 0);
    empty.innerHTML = `<p class="empty-title">No match for “${esc(q)}”</p>`
      + (elsewhere ? `<p><button type="button" class="link" data-showall>Search all guests</button></p>` : '')
      + (showAdd ? `<ul class="list">${addRows(q, false)}</ul>` : '');
  } else {
    empty.innerHTML = state.filter === 'arrived'
      ? '<p class="empty-title">Nobody has arrived yet</p>'
      : '<p class="empty-title">Everyone is here</p><p>All guests have been checked in.</p>';
  }
}

function renderConn() {
  const el = $('#conn');
  let text = '';
  if (!state.online) text = 'Offline';
  else if (state.loaded && !state.live && !isDemo) text = 'Reconnecting…';
  el.hidden = !text;
  el.textContent = text;
}

function setBanner(html, kind = 'warn') {
  const b = $('#banner');
  b.hidden = !html;
  b.className = `banner ${kind}`;
  b.innerHTML = html || '';
}

// ---------- toasts ----------
let toastTimer = null;
function toast(msg, { action, onAction, kind = '', ms = 4500 } = {}) {
  const wrap = $('#toastWrap');
  wrap.innerHTML = `<div class="toast ${kind}" role="status"><span class="toast-msg">${msg}</span>${
    action ? `<button type="button" class="toast-action">${esc(action)}</button>` : ''}</div>`;
  const el = wrap.firstElementChild;
  requestAnimationFrame(() => el.classList.add('show'));
  if (action) {
    $('.toast-action', el).addEventListener('click', () => { dismissToast(); onAction(); });
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, ms);
}
function dismissToast() {
  const el = $('#toastWrap').firstElementChild;
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 200);
}

// ---------- data sync ----------
let refetchTimer = null;
function refetch() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(async () => {
    try {
      const rows = await store.fetchAll();
      // Keep optimistic rows that are still in flight so they don't flicker back.
      const pending = allGuests().filter((g) => g._pending);
      state.guests = new Map(rows.map((r) => [r.id, r]));
      pending.forEach((g) => { if (state.guests.has(g.id) || g._new) state.guests.set(g.id, g); });
      state.loaded = true;
      setBanner('');
      if (isDemo) showDemoBanner();
      render();
    } catch (e) {
      showLoadError(e);
    }
  }, 60);
}

function applyEvent(ev) {
  if (ev.type === 'delete') {
    if (ev.id) state.guests.delete(ev.id);
  } else if (ev.row && ev.row.id) {
    const cur = state.guests.get(ev.row.id);
    // An echo of our own in-flight write: keep the optimistic copy until the RPC settles.
    if (!(cur && cur._pending)) state.guests.set(ev.row.id, ev.row);
  }
  render();
}

function showLoadError(e) {
  const missing = e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message));
  if (missing) {
    setBanner('<b>Database not set up.</b> Run <code>db/schema.sql</code> in the Supabase SQL editor, then reload.', 'error');
  } else {
    const network = !navigator.onLine || /fetch|network|load the supabase/i.test(e && e.message);
    const why = network ? 'Can’t reach the database. Check your connection.' : esc(e && e.message || e);
    setBanner(`<b>Couldn’t load the list.</b> ${why} <button type="button" class="link" data-retry>Retry</button>`, 'error');
  }
  if (!state.loaded) $('#empty').hidden = true;
}

// Run a write; on failure restore the snapshot and explain. Returns the result or undefined.
async function mutate(fn, rollback, failMsg) {
  try {
    return await fn(state.token);
  } catch (e) {
    rollback && rollback();
    render();
    if (isAuthError(e)) {
      lock(false);
      openUnlock('The password has changed. Enter the new one to keep editing.');
    } else if (e && e.code === 'P0002') {
      toast('That guest was removed on another device.', { kind: 'error' });
      refetch();
    } else {
      const offline = !navigator.onLine || /fetch|network/i.test(e && e.message);
      toast(`${esc(failMsg)} ${offline ? 'Check your connection and try again.' : esc(e && e.message || '')}`, { kind: 'error', ms: 6000 });
    }
    return undefined;
  }
}

// ---------- actions ----------
async function setArrived(id, arrived, { at = null, silent = false } = {}) {
  const g = state.guests.get(id);
  if (!g) return;
  const before = { ...g };
  const optimistic = { ...g, arrived_at: arrived ? (at || new Date().toISOString()) : null, _pending: true };
  state.guests.set(id, optimistic);
  if (arrived) flashId = id;
  render();
  if (!silent) {
    if (arrived) {
      buzz(15);
      toast(`<b>${esc(g.name)}</b> checked in`, {
        kind: 'success', action: 'Undo',
        onAction: () => setArrived(id, false, { silent: true }),
      });
    } else {
      toast(`<b>${esc(g.name)}</b> marked not arrived`, {
        action: 'Undo',
        onAction: () => setArrived(id, true, { at: before.arrived_at, silent: true }),
      });
    }
  }
  const row = await mutate(
    (token) => store.setArrived(token, id, arrived, at),
    () => state.guests.set(id, before),
    `Couldn’t update ${g.name}.`,
  );
  if (row) { state.guests.set(id, row); render(); }
}

// Tap on a guest row.
function onGuestTap(id) {
  if (!unlocked()) { openUnlock(); return; }
  const g = state.guests.get(id);
  if (!g) return;
  if (g.arrived_at) {
    // Never silently un-check someone at the door: a second tap usually means a
    // duplicate entry attempt, so warn and offer the reversal explicitly.
    buzz([10, 60, 10]);
    toast(`<b>${esc(g.name)}</b> already arrived at ${esc(fmtTime(g.arrived_at))}`, {
      kind: 'warn', action: 'Mark not arrived', ms: 6000,
      onAction: () => setArrived(id, false),
    });
    pulse(id, 'shake');
    return;
  }
  setArrived(id, true);
  resetSearchForNextGuest();
}

function pulse(id, cls) {
  const li = $(`li[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.classList.remove(cls);
  void li.offsetWidth; // restart the animation
  li.classList.add(cls);
}

// After a check-in from a search, clear the box so the next name can be typed right away.
function resetSearchForNextGuest() {
  if (!state.query) return;
  setQuery('');
  // Re-focus only if the keyboard was already in use (avoid popping it open on a plain tap).
  if (lastSearchFocusAt && Date.now() - lastSearchFocusAt < 60000) $('#search').focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

async function addGuests(names, note, { arrived = false } = {}) {
  const temp = names.map((name) => ({
    id: `tmp-${crypto.randomUUID()}`, name, note, arrived_at: arrived ? new Date().toISOString() : null,
    _pending: true, _new: true,
  }));
  temp.forEach((t) => state.guests.set(t.id, t));
  if (arrived && temp[0]) flashId = temp[0].id;
  render();
  const rows = await mutate(
    (token) => store.add(token, names, note, arrived),
    () => temp.forEach((t) => state.guests.delete(t.id)),
    'Couldn’t add guests.',
  );
  temp.forEach((t) => state.guests.delete(t.id));
  if (rows) {
    rows.forEach((r) => state.guests.set(r.id, r));
    if (arrived && rows[0]) flashId = rows[0].id;
  }
  render();
  return rows;
}

async function walkIn(name, arrived) {
  const rows = await addGuests([name], '', { arrived });
  if (!rows || !rows[0]) return;
  const g = rows[0];
  if (arrived) {
    buzz(15);
    toast(`<b>${esc(g.name)}</b> added &amp; checked in`, {
      kind: 'success', action: 'Undo',
      onAction: () => removeGuest(g.id, { silent: true }),
    });
    resetSearchForNextGuest();
  } else {
    toast(`<b>${esc(g.name)}</b> added to the list`, { kind: 'success' });
  }
}

async function removeGuest(id, { silent = false } = {}) {
  const g = state.guests.get(id);
  if (!g) return;
  state.guests.delete(id);
  render();
  const ok = await mutate(
    (token) => store.remove(token, id).then(() => true),
    () => state.guests.set(id, g),
    `Couldn’t delete ${g.name}.`,
  );
  if (ok && !silent) toast(`<b>${esc(g.name)}</b> deleted`);
}

// ---------- lock / unlock ----------
// Keep the token until the device is locked. Safari expires cookies written by
// JS after 7 days, so ask api/session to set it from the server; without that
// endpoint (local dev) fall back to setting it here.
async function saveToken(token) {
  lsSet(legacyPwKey, null);
  let saved = false;
  try {
    const res = await fetch('api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tokenCookie, value: token, path: COOKIE_PATH }),
    });
    saved = res.ok && cookieGet(tokenCookie) === token;
  } catch { /* offline, or no endpoint */ }
  if (state.token !== token) {
    // Locked while the request was out: don't leave this token behind.
    if (cookieGet(tokenCookie) === token) cookieSet(tokenCookie, '', 0);
  } else if (!saved) {
    cookieSet(tokenCookie, token, COOKIE_MAX_AGE);
  }
}

function forgetToken() {
  cookieSet(tokenCookie, '', 0);
  lsSet(legacyPwKey, null);
}

// Devices unlocked by an older build kept the password itself. Writes still
// accept it, so stay unlocked and quietly trade it for a token.
async function upgradeLegacyPassword() {
  const pw = lsGet(legacyPwKey);
  if (!pw) return;
  if (state.token !== pw) { lsSet(legacyPwKey, null); return; }
  try {
    const token = await store.login(pw);
    if (state.token !== pw) return; // locked or re-unlocked meanwhile
    if (!token) { lock(false); return; } // the password was changed since
    state.token = token;
    saveToken(token);
  } catch { /* offline: try again on the next launch */ }
}

function lock(withToast = true) {
  state.token = null;
  forgetToken();
  closeAllModals();
  render();
  if (withToast) toast('Locked. This device is now view-only.');
}

function openUnlock(message) {
  $('#unlockError').hidden = !message;
  $('#unlockError').textContent = message || '';
  $('#unlockPw').value = '';
  openModal('#unlockModal', '#unlockPw');
}

async function submitUnlock(e) {
  e.preventDefault();
  const pw = $('#unlockPw').value;
  if (!pw) return;
  const btn = $('#unlockSubmit');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const token = await store.login(pw);
    if (!token) {
      $('#unlockError').textContent = 'Wrong password. Try again.';
      $('#unlockError').hidden = false;
      $('#unlockPw').select();
      buzz([10, 60, 10]);
      return;
    }
    state.token = token;
    closeModal('#unlockModal');
    render();
    toast('Unlocked. Tap a name to check them in.', { kind: 'success' });
    saveToken(token);
  } catch (err) {
    const notSet = err && err.code === '28000';
    $('#unlockError').textContent = notSet
      ? 'No password is set yet. Run guestlist_set_password in the Supabase SQL editor.'
      : `Couldn’t check the password: ${err && err.message || err}`;
    $('#unlockError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

// ---------- modals ----------
let lastFocus = null;
function openModal(sel, focusSel) {
  lastFocus = document.activeElement;
  const m = $(sel);
  m.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => m.classList.add('open'));
  if (focusSel) setTimeout(() => $(focusSel).focus(), 60);
}
function closeModal(sel) {
  const m = $(sel);
  if (m.hidden) return;
  m.classList.remove('open');
  m.hidden = true;
  if (!$$('.overlay').some((o) => !o.hidden)) document.body.classList.remove('modal-open');
  if (sel === '#editModal') state.editingId = null;
  if (lastFocus && document.contains(lastFocus) && lastFocus !== document.body) lastFocus.focus({ preventScroll: true });
}
function closeAllModals() { $$('.overlay').forEach((m) => closeModal(`#${m.id}`)); }

// Add sheet: parse lines, skip blanks + duplicates (against the list and within the paste).
function parseAddNames() {
  const seen = new Set(allGuests().map((g) => norm(g.name)));
  const fresh = [];
  const dupes = [];
  for (const line of $('#addNames').value.split(/\r?\n/)) {
    const name = line.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!name) continue;
    const n = norm(name);
    if (seen.has(n)) { dupes.push(name); continue; }
    seen.add(n);
    fresh.push(name);
  }
  return { fresh, dupes };
}
function renderAddHint() {
  const { fresh, dupes } = parseAddNames();
  const parts = [];
  if (fresh.length) parts.push(`${fresh.length} new ${fresh.length === 1 ? 'guest' : 'guests'}`);
  if (dupes.length) {
    const shown = dupes.slice(0, 3).map(esc).join(', ') + (dupes.length > 3 ? ` +${dupes.length - 3} more` : '');
    parts.push(`<span class="warn-text">${dupes.length} already on the list, will be skipped: ${shown}</span>`);
  }
  $('#addHint').innerHTML = parts.join(' · ');
  const btn = $('#addSubmit');
  btn.disabled = !fresh.length;
  btn.textContent = fresh.length > 1 ? `Add ${fresh.length}` : 'Add';
}
function openAdd() {
  $('#addNames').value = '';
  $('#addNote').value = '';
  renderAddHint();
  openModal('#addModal', '#addNames');
}
async function submitAdd(e) {
  e.preventDefault();
  const { fresh } = parseAddNames();
  if (!fresh.length) return;
  const note = $('#addNote').value.trim();
  closeModal('#addModal');
  const rows = await addGuests(fresh, note);
  if (rows) toast(rows.length === 1 ? `<b>${esc(rows[0].name)}</b> added` : `<b>${rows.length}</b> guests added`, { kind: 'success' });
}

let deleteArmed = false;
function openEdit(id) {
  const g = state.guests.get(id);
  if (!g) return;
  state.editingId = id;
  $('#editName').value = g.name;
  $('#editNote').value = g.note || '';
  $('#editError').hidden = true;
  setDeleteArmed(false);
  renderEditStatus();
  openModal('#editModal');
}
function renderEditStatus() {
  const g = state.guests.get(state.editingId);
  if (!g) return;
  $('#editStatus').innerHTML = g.arrived_at
    ? `<span class="pill ok">Arrived ${esc(fmtTime(g.arrived_at))}</span><button type="button" class="link" data-edit-arrive="0">Mark not arrived</button>`
    : `<span class="pill">Not arrived</span><button type="button" class="link" data-edit-arrive="1">Check in now</button>`;
}
function setDeleteArmed(on) {
  deleteArmed = on;
  const b = $('#editDelete');
  b.textContent = on ? 'Tap again to delete' : 'Delete';
  b.classList.toggle('armed', on);
}
async function submitEdit(e) {
  e.preventDefault();
  const id = state.editingId;
  const g = state.guests.get(id);
  if (!g) { closeModal('#editModal'); return; }
  const name = $('#editName').value.replace(/\s+/g, ' ').trim();
  const note = $('#editNote').value.trim();
  if (!name) {
    $('#editError').textContent = 'Name can’t be empty.';
    $('#editError').hidden = false;
    $('#editName').focus();
    return;
  }
  closeModal('#editModal');
  if (name === g.name && note === (g.note || '')) return;
  const before = { ...g };
  state.guests.set(id, { ...g, name, note, _pending: true });
  render();
  const row = await mutate(
    (token) => store.update(token, id, name, note),
    () => state.guests.set(id, before),
    `Couldn’t save ${g.name}.`,
  );
  if (row) { state.guests.set(id, row); render(); toast('Saved', { kind: 'success', ms: 2000 }); }
}

// ---------- CSV export ----------
function csvCell(v) {
  let s = String(v ?? '');
  // Stop spreadsheet apps from evaluating a name like "=HYPERLINK(...)" as a formula.
  // Plain "+1" / "-2" notes are harmless, so they stay readable.
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]\d+$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function exportCsv() {
  const rows = allGuests().filter((g) => !g._new).sort(byName);
  if (!rows.length) { toast('The list is empty, nothing to export.'); return; }
  const lines = [['Name', 'Note', 'Status', 'Arrived at', 'Added at'].join(',')];
  for (const g of rows) {
    lines.push([g.name, g.note, g.arrived_at ? 'Arrived' : 'Not arrived', csvDate(g.arrived_at), csvDate(g.created_at)]
      .map(csvCell).join(','));
  }
  // BOM so Excel opens accented names correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `guestlist-${csvDate(new Date().toISOString()).replace(' ', '-').replace(':', '')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Exported ${rows.length} ${rows.length === 1 ? 'guest' : 'guests'}`, { kind: 'success' });
}

// ---------- wiring ----------
let lastSearchFocusAt = 0;
function setQuery(q) {
  state.query = q;
  $('#search').value = q;
  $('#searchClear').hidden = !q;
  render();
}

function wire() {
  const search = $('#search');
  search.addEventListener('input', () => setQuery(search.value));
  search.addEventListener('focus', () => { lastSearchFocusAt = Date.now(); });
  search.addEventListener('keydown', (e) => {
    lastSearchFocusAt = Date.now();
    if (e.key === 'Escape') { setQuery(''); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Enter checks in the top match when it's the only one still waiting.
    const waiting = visibleGuests().filter((g) => !g.arrived_at);
    if (state.query.trim() && waiting.length === 1) onGuestTap(waiting[0].id);
    else search.blur(); // dismiss the phone keyboard to see the results
  });
  $('#searchClear').addEventListener('click', () => { setQuery(''); search.focus(); });

  $$('.filter').forEach((b) => b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    lsSet(FILTER_KEY, state.filter);
    render();
  }));

  document.addEventListener('click', (e) => {
    const t = e.target;
    const li = t.closest('li[data-id]');
    if (li && t.closest('[data-edit]')) { if (unlocked()) openEdit(li.dataset.id); return; }
    if (li && t.closest('[data-toggle]')) { onGuestTap(li.dataset.id); return; }
    if (t.closest('[data-walkin]')) { walkIn(state.query.replace(/\s+/g, ' ').trim(), true); return; }
    if (t.closest('[data-addname]')) { walkIn(state.query.replace(/\s+/g, ' ').trim(), false); return; }
    if (t.closest('[data-showall]')) { state.filter = 'all'; lsSet(FILTER_KEY, 'all'); render(); return; }
    if (t.closest('[data-retry]')) { setBanner(''); boot(); return; }
    const ea = t.closest('[data-edit-arrive]');
    if (ea && state.editingId) {
      const id = state.editingId;
      closeModal('#editModal');
      setArrived(id, ea.dataset.editArrive === '1');
      return;
    }
    if (t.closest('[data-close]')) { closeModal(`#${t.closest('.overlay').id}`); return; }
    // Tap on the dimmed backdrop closes the sheet.
    if (t.classList.contains('overlay')) closeModal(`#${t.id}`);
  });

  $('#lockBtn').addEventListener('click', () => (unlocked() ? lock() : openUnlock()));
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#addBtn').addEventListener('click', openAdd);
  $('#unlockForm').addEventListener('submit', submitUnlock);
  $('#addForm').addEventListener('submit', submitAdd);
  $('#addNames').addEventListener('input', renderAddHint);
  $('#addNames').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAdd(e);
  });
  $('#editForm').addEventListener('submit', submitEdit);
  $('#editDelete').addEventListener('click', () => {
    if (!deleteArmed) { setDeleteArmed(true); return; }
    const id = state.editingId;
    closeModal('#editModal');
    removeGuest(id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = $$('.overlay').find((o) => !o.hidden);
      if (open) { closeModal(`#${open.id}`); return; }
    }
    // "/" jumps to search from anywhere (like most web apps).
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)
      && !$$('.overlay').some((o) => !o.hidden)) {
      e.preventDefault();
      search.focus();
    }
  });

  // Catch up on anything missed while the phone was asleep or offline.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && store) refetch(); });
  window.addEventListener('online', () => { state.online = true; renderConn(); if (store) refetch(); });
  window.addEventListener('offline', () => { state.online = false; renderConn(); });

  // Arrival times like "9:14 PM" vs "Oct 24, 9:14 PM" change at midnight.
  setInterval(() => { if (state.loaded && !document.hidden) render(); }, 60000);
}

function showDemoBanner() {
  setBanner(`<b>Demo mode.</b> Changes stay on this device. Password: <code>${DEMO_PASSWORD}</code>`, 'info');
}

// Localhost defaults to the demo store so development never touches real
// guests; ?env=live opts in. ?demo=1 forces demo anywhere.
function pickStore() {
  const params = new URLSearchParams(location.search);
  const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const configured = window.SUPABASE_URL && window.SUPABASE_ANON_KEY;
  isDemo = params.has('demo') || !configured || (local && params.get('env') !== 'live');
  const badge = $('#envBadge');
  if (isDemo) { badge.hidden = false; badge.textContent = 'DEMO'; badge.className = 'env-badge demo'; }
  else if (local) { badge.hidden = false; badge.textContent = 'LIVE DB'; badge.className = 'env-badge live'; }
  // Demo and live remember different tokens.
  if (isDemo) { tokenCookie = 'gl_demo_token'; legacyPwKey = 'gl_demo_pw'; }
  state.token = cookieGet(tokenCookie) || lsGet(legacyPwKey);
  return isDemo ? createLocalStore() : createSupabaseStore();
}

let booted = false;
async function boot() {
  try {
    await store.init();
    upgradeLegacyPassword();
    const rows = await store.fetchAll();
    state.guests = new Map(rows.map((r) => [r.id, r]));
    state.loaded = true;
    if (isDemo) showDemoBanner();
    render();
    if (!booted) {
      booted = true;
      store.subscribe(applyEvent, (up) => {
        const wasDown = !state.live;
        state.live = up;
        renderConn();
        if (up && wasDown && state.loaded) refetch(); // reconnected: resync
      });
    }
  } catch (e) {
    showLoadError(e);
  }
}

function main() {
  store = pickStore();
  wire();
  render();
  $('#empty').hidden = false;
  $('#empty').innerHTML = '<p class="empty-title muted">Loading…</p>';
  boot();
}

main();
