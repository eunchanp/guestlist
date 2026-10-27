/* ============================================================
   Schema test: runs db/schema.sql in PGlite (Postgres compiled to
   WASM, in memory) with stand-ins for what Supabase provides, then
   checks the security model and every RPC as the browser calls them
   (role anon). Nothing touches the real database.

   Run: cd dev && npm install && npm test
   Another schema file: node test-schema.mjs path/to/schema.sql
   ============================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const schemaPath = process.argv[2] || new URL('../db/schema.sql', import.meta.url);
const schema = readFileSync(schemaPath, 'utf8');

// What the browser may execute. Adding a client RPC means adding it here too;
// anything else showing up as executable is a missing `revoke ... from public`.
const CLIENT_API = ['guestlist_add', 'guestlist_clear', 'guestlist_delete', 'guestlist_login',
  'guestlist_restore', 'guestlist_set_arrived', 'guestlist_undo_clear', 'guestlist_update'];
const CLIENT_ROLES = ['anon', 'authenticated'];

const db = new PGlite({ extensions: { pgcrypto } });
// Supabase provides these; schema.sql assumes them. The default privileges
// matter: Supabase grants clients everything on new tables and functions in
// public, so the schema's revokes are what actually lock writes down.
await db.exec(`
  create schema extensions;
  create role anon;
  create role authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  create publication supabase_realtime;
`);

// ---------- helpers ----------
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];
// Run fn as a client role (the SQL editor is the superuser).
async function as(role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function fails(code, sql, params) {
  await assert.rejects(db.query(sql, params), (e) => {
    assert.equal(e.code, code, `${sql}\n     expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
    return true;
  }, `${sql}\n     expected SQLSTATE ${code}, but it succeeded`);
}
const anon = (sql, params) => as('anon', () => rows(sql, params));
const anonOne = async (sql, params) => (await anon(sql, params))[0];
const anonFails = (code, sql, params) => as('anon', () => fails(code, sql, params));

const add = (token, names, note = '', arrived = false) =>
  anon('select * from guestlist_add($1, $2::text[], $3, $4)', [token, names, note, arrived]);

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n     ${e.message}`);
  }
}

// ---------- tests (in order: they share one database) ----------
let token;
const missing = '00000000-0000-0000-0000-000000000000';

await test('schema applies, and re-applies cleanly', async () => {
  await db.exec(schema);
  await db.exec(schema);
});

await test('before a password is set, unlocking says so (28000)', async () => {
  await anonFails('28000', `select guestlist_login('anything')`);
  await anonFails('28000', `select guestlist_add('anything', array['Ava'])`);
});

await test('set_password rejects passwords under 4 characters', async () => {
  await fails('P0001', `select guestlist_set_password('abc')`);
  await db.query(`select guestlist_set_password('secret')`);
});

await test('login trades the password for a device token; wrong or null gives null', async () => {
  token = (await anonOne(`select guestlist_login('secret') as t`)).t;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await anonOne(`select guestlist_login('wrong') as t`)).t, null);
  assert.equal((await anonOne('select guestlist_login(null) as t')).t, null);
});

await test('add trims, skips blank names, keeps order, stamps arrivals', async () => {
  const added = await add(token, ['  Ava  Lee ', '', '   ', 'Ben'], ' +1 ');
  assert.deepEqual(added.map((r) => r.name), ['Ava  Lee', 'Ben']);
  assert.deepEqual(added.map((r) => r.note), ['+1', '+1']);
  assert.ok(added.every((r) => r.arrived_at === null));
  const [walkIn] = await add(token, ['Cam'], '', true);
  assert.ok(walkIn.arrived_at instanceof Date);
});

await test('the password itself still works for writes (legacy devices)', async () => {
  assert.equal((await add('secret', ['Dee'])).length, 1);
});

await test('update renames and trims; a missing guest is P0002', async () => {
  const { id } = await one(`select id from guestlist_guests where name = 'Ben'`);
  const r = await anonOne('select * from guestlist_update($1, $2, $3, $4)', [token, id, ' Benjamin ', ' VIP ']);
  assert.equal(r.name, 'Benjamin');
  assert.equal(r.note, 'VIP');
  await anonFails('P0002', 'select guestlist_update($1, $2, $3, $4)', [token, missing, 'X', '']);
});

await test('set_arrived checks in and out; p_at restores an exact time', async () => {
  const { id } = await one(`select id from guestlist_guests where name = 'Benjamin'`);
  const setArrived = (arrived, at = null) =>
    anonOne('select * from guestlist_set_arrived($1, $2, $3, $4)', [token, id, arrived, at]);
  assert.ok((await setArrived(true)).arrived_at instanceof Date);
  assert.equal((await setArrived(false)).arrived_at, null);
  const at = '2026-01-02T03:04:05.000Z';
  assert.equal((await setArrived(true, at)).arrived_at.toISOString(), at);
  await anonFails('P0002', 'select guestlist_set_arrived($1, $2, true)', [token, missing]);
});

await test('delete removes one guest', async () => {
  const { id } = await one(`select id from guestlist_guests where name = 'Dee'`);
  await anon('select guestlist_delete($1, $2)', [token, id]);
  assert.equal((await one('select count(*)::int as n from guestlist_guests where id = $1', [id])).n, 0);
});

await test('restore brings a deleted guest back as they were, once', async () => {
  const [g] = await add(token, ['Dot'], 'VIP', true);
  await anon('select guestlist_delete($1, $2)', [token, g.id]);
  const restore = () => anonOne('select * from guestlist_restore($1, $2, $3, $4, $5, $6)',
    [token, g.id, g.name, g.note, g.arrived_at, g.created_at]);
  const r = await restore();
  assert.equal(r.id, g.id);
  assert.equal(r.name, 'Dot');
  assert.equal(r.note, 'VIP');
  assert.equal(r.arrived_at.toISOString(), g.arrived_at.toISOString());
  assert.equal(r.created_at.toISOString(), g.created_at.toISOString());
  assert.equal((await restore()).id, g.id); // already back: no error, no duplicate
  assert.equal((await one('select count(*)::int as n from guestlist_guests where id = $1', [g.id])).n, 1);
});

await test('names must be 1-200 characters and notes at most 500 (23514)', async () => {
  const { id } = await one(`select id from guestlist_guests where name = 'Cam'`);
  await anonFails('23514', 'select guestlist_update($1, $2, $3, $4)', [token, id, '   ', '']);
  await anonFails('23514', 'select guestlist_add($1, $2::text[])', [token, ['x'.repeat(201)]]);
  await anonFails('23514', 'select guestlist_add($1, $2::text[], $3)', [token, ['Eve'], 'x'.repeat(501)]);
});

await test('clients can read the list but not write the table directly (42501)', async () => {
  for (const role of CLIENT_ROLES) {
    await as(role, async () => {
      assert.ok((await one('select count(*)::int as n from guestlist_guests')).n > 0);
      await fails('42501', `insert into guestlist_guests (name) values ('Mallory')`);
      await fails('42501', `update guestlist_guests set name = 'Mallory'`);
      await fails('42501', 'delete from guestlist_guests');
      await fails('42501', 'truncate guestlist_guests');
    });
  }
});

await test('clients can not see the secret or call the internal functions (42501)', async () => {
  for (const role of CLIENT_ROLES) {
    await as(role, async () => {
      await fails('42501', 'select * from guestlist_secret');
      await fails('42501', 'select * from guestlist_cleared');
      await fails('42501', `select guestlist_set_password('hijacked')`);
      await fails('42501', 'select guestlist_require($1)', [token]);
      await fails('42501', `select guestlist_device_token('x')`);
    });
  }
});

await test('clients can execute exactly the client API', async () => {
  for (const role of CLIENT_ROLES) {
    const fns = await rows(`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'guestlist\\_%'
         and has_function_privilege($1, p.oid, 'execute')
       order by 1`, [role]);
    assert.deepEqual(fns.map((f) => f.name), CLIENT_API, `${role} can execute`);
  }
});

await test('every guestlist function pins search_path to empty', async () => {
  const loose = await rows(`
    select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'guestlist\\_%'
       and not coalesce('search_path=""' = any(p.proconfig), false)`);
  assert.deepEqual(loose.map((f) => f.name), []);
});

await test('every write refuses a wrong token (28P01)', async () => {
  const { id } = await one(`select id from guestlist_guests where name = 'Cam'`);
  await anonFails('28P01', `select guestlist_add('nope', array['X'])`);
  await anonFails('28P01', `select guestlist_update('nope', $1, 'X', '')`, [id]);
  await anonFails('28P01', `select guestlist_set_arrived('nope', $1, true)`, [id]);
  await anonFails('28P01', `select guestlist_delete('nope', $1)`, [id]);
  await anonFails('28P01', `select guestlist_restore('nope', $1, 'X', '', null, null)`, [missing]);
  await anonFails('28P01', `select guestlist_clear('nope')`);
  await anonFails('28P01', `select guestlist_undo_clear('nope', $1)`, [missing]);
  await anonFails('28P01', 'select guestlist_add(null, array[$1])', ['X']);
});

await test('changing the password revokes every device token', async () => {
  await db.query(`select guestlist_set_password('secret2')`);
  await anonFails('28P01', `select guestlist_add($1, array['X'])`, [token]);
  await anonFails('28P01', `select guestlist_add('secret', array['X'])`);
  token = (await anonOne(`select guestlist_login('secret2') as t`)).t;
  assert.match(token, /^[0-9a-f]{64}$/);
});

await test('re-running the schema keeps the guests and the password', async () => {
  const before = (await one('select count(*)::int as n from guestlist_guests')).n;
  await db.exec(schema);
  assert.equal((await one('select count(*)::int as n from guestlist_guests')).n, before);
  assert.equal((await anonOne('select guestlist_login($1) as t', ['secret2'])).t, token);
});

await test('the schema upgrades a guestlist_clear that returned a count', async () => {
  await db.exec(`drop function guestlist_clear(text);
    create function guestlist_clear(p_password text) returns integer language sql as 'select 0';`);
  await db.exec(schema);
  const { t } = await one(`select pg_get_function_result('guestlist_clear(text)'::regprocedure) as t`);
  assert.equal(t, 'jsonb');
  assert.ok((await one(`select has_function_privilege('anon', 'guestlist_clear(text)', 'execute') as ok`)).ok);
});

const clear = async () => (await anonOne('select guestlist_clear($1) as r', [token])).r;
const undoClear = (batch) => anon('select * from guestlist_undo_clear($1, $2) order by id', [token, batch]);
const snapshot = (list) => list.map((g) => ({
  id: g.id, name: g.name, note: g.note, arrived_at: g.arrived_at?.toISOString() ?? null,
  created_at: g.created_at.toISOString(),
}));
let lastClear;

await test('clear deletes everyone and returns the count and a batch', async () => {
  const before = await rows('select * from guestlist_guests order by id');
  assert.ok(before.length > 1 && before.some((g) => g.arrived_at) && before.some((g) => g.note));
  const r = await clear();
  assert.equal(r.count, before.length);
  assert.match(r.batch, /^[0-9a-f-]{36}$/);
  assert.equal((await one('select count(*)::int as n from guestlist_guests')).n, 0);
  lastClear = { batch: r.batch, before };
});

await test('undo_clear restores those guests as they were, only once', async () => {
  const back = await undoClear(lastClear.batch);
  assert.deepEqual(snapshot(back), snapshot(lastClear.before));
  assert.deepEqual(snapshot(await rows('select * from guestlist_guests order by id')), snapshot(lastClear.before));
  assert.deepEqual(await undoClear(lastClear.batch), []);
  assert.equal((await one('select count(*)::int as n from guestlist_cleared')).n, 0);
});

await test('a later clear replaces what can be undone', async () => {
  const first = await clear();
  await add(token, ['Zed']);
  const second = await clear();
  assert.equal(second.count, 1);
  assert.deepEqual(await undoClear(first.batch), []);
  assert.deepEqual((await undoClear(second.batch)).map((g) => g.name), ['Zed']);
  await clear();
  assert.equal((await clear()).count, 0);
});

await test('realtime publishes guestlist_guests', async () => {
  const pub = await rows(`select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'guestlist_guests'`);
  assert.equal(pub.length, 1);
});

await db.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
