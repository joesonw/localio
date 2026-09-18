import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import { loadConfig } from '../config.js';
import { Store } from '../db/index.js';
import { LocalioServer } from '../server.js';

/**
 * `/admin`, and specifically the rule the whole surface turns on: **a credential is not in
 * a listing**. It is answered once when it is created and again only when a read asks for
 * it by name, because the Admin panel polls these routes every two seconds and a secret
 * in that stream is a secret in every log and proxy between here and the tab.
 */

async function fixture(): Promise<{ server: LocalioServer; store: Store; accountSid: string }> {
  const store = Store.open({ path: ':memory:' });
  const account = store.accounts.create({ friendlyName: 'test' });
  const config = { ...loadConfig({}), dbPath: ':memory:' };
  const server = new LocalioServer({ store, config, logger: pino({ level: 'silent' }) });
  await server.app.ready();
  return { server, store, accountSid: account.accountSid };
}

test('creating a key answers its secret, and the listing does not', async () => {
  const { server, accountSid } = await fixture();
  const created = await server.app.inject({
    method: 'POST',
    url: '/admin/keys',
    payload: { account_sid: accountSid, friendly_name: 'ci' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const key = created.json();
  assert.match(key.sid, /^SK[0-9a-f]{32}$/);
  assert.equal(key.account_sid, accountSid);
  assert.equal(typeof key.secret, 'string');

  const list = await server.app.inject({ url: '/admin/keys' });
  assert.deepEqual(list.json().keys.map((row: { sid: string }) => row.sid), [key.sid]);
  assert.ok(!('secret' in list.json().keys[0]), 'a listing must not carry a secret');

  const read = await server.app.inject({ url: `/admin/keys/${key.sid}` });
  assert.ok(!('secret' in read.json()));

  const revealed = await server.app.inject({ url: `/admin/keys/${key.sid}?reveal=1` });
  assert.equal(revealed.json().secret, key.secret);
  await server.close();
});

test('a key is renamed and deleted, and the account counts it', async () => {
  const { server, accountSid } = await fixture();
  const created = await server.app.inject({
    method: 'POST',
    url: '/admin/keys',
    payload: { account_sid: accountSid },
  });
  const { sid } = created.json();

  const accounts = await server.app.inject({ url: '/admin/accounts' });
  assert.equal(accounts.json().accounts[0].key_count, 1);

  const renamed = await server.app.inject({
    method: 'PATCH',
    url: `/admin/keys/${sid}`,
    payload: { friendly_name: 'renamed' },
  });
  assert.equal(renamed.json().friendly_name, 'renamed');

  const removed = await server.app.inject({ method: 'DELETE', url: `/admin/keys/${sid}` });
  assert.equal(removed.statusCode, 204);
  assert.equal((await server.app.inject({ method: 'DELETE', url: `/admin/keys/${sid}` })).statusCode, 404);
  await server.close();
});

/** A key of an account nothing holds would be a credential for nothing. */
test('a key for an unknown account is refused by name', async () => {
  const { server } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: '/admin/keys',
    payload: { account_sid: `AC${'9'.repeat(32)}` },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'no_such_account');
  await server.close();
});

test('a bad body answers 400 naming the field', async () => {
  const { server } = await fixture();
  const response = await server.app.inject({ method: 'POST', url: '/admin/keys', payload: {} });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_request');
  assert.match(response.json().message, /account_sid/);
  await server.close();
});

/** Deleting an account deletes its keys — otherwise the foreign key refuses it opaquely. */
test('deleting an account takes its keys with it', async () => {
  const { server, accountSid } = await fixture();
  await server.app.inject({ method: 'POST', url: '/admin/keys', payload: { account_sid: accountSid } });
  const removed = await server.app.inject({ method: 'DELETE', url: `/admin/accounts/${accountSid}` });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual((await server.app.inject({ url: '/admin/keys' })).json().keys, []);
  await server.close();
});

/* --------------------------------------------------------------- subaccounts */

/** The whole subaccount round trip over `/admin`: create with a parent, see it in the listing. */
test('an account created with a parent is a subaccount, and the listing says so', async () => {
  const { server, accountSid } = await fixture();
  const created = await server.app.inject({
    method: 'POST',
    url: '/admin/accounts',
    payload: { friendly_name: 'tenant-a', parent_account_sid: accountSid },
  });
  assert.equal(created.statusCode, 201, created.body);
  const child = created.json();
  assert.equal(child.parent_account_sid, accountSid);
  assert.equal(child.status, 'active');
  assert.equal(typeof child.auth_token, 'string', 'a new account answers its token once');
  assert.notEqual(child.account_sid, accountSid, 'a subaccount has a sid of its own');

  const list = (await server.app.inject({ url: '/admin/accounts' })).json();
  const parent = list.accounts.find((row: { account_sid: string }) => row.account_sid === accountSid);
  assert.equal(parent.subaccount_count, 1);
  assert.equal(parent.parent_account_sid, null, 'a top-level account has no parent');
  assert.ok(!('auth_token' in parent), 'a listing must not carry a token');
  await server.close();
});

/** A parent has to exist, and the refusal names it — the same shape the numbers route uses. */
test('a subaccount of an unknown parent is refused by name', async () => {
  const { server } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: '/admin/accounts',
    payload: { parent_account_sid: `AC${'9'.repeat(32)}` },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'no_such_account');
  await server.close();
});

/** **One level, strictly.** A subaccount cannot hold subaccounts. */
test('a subaccount cannot itself be named as a parent', async () => {
  const { server, accountSid } = await fixture();
  const child = (
    await server.app.inject({
      method: 'POST',
      url: '/admin/accounts',
      payload: { parent_account_sid: accountSid },
    })
  ).json();

  const response = await server.app.inject({
    method: 'POST',
    url: '/admin/accounts',
    payload: { parent_account_sid: child.account_sid },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'not_a_parent');
  await server.close();
});

/** A child is not swept up by its parent's delete; it is released by deleting it first. */
test('deleting a parent is refused while it still has subaccounts, and says how many', async () => {
  const { server, accountSid } = await fixture();
  const child = (
    await server.app.inject({
      method: 'POST',
      url: '/admin/accounts',
      payload: { parent_account_sid: accountSid },
    })
  ).json();

  const refused = await server.app.inject({ method: 'DELETE', url: `/admin/accounts/${accountSid}` });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 'has_subaccounts');
  assert.match(refused.json().message, /1 subaccount/);

  assert.equal(
    (await server.app.inject({ method: 'DELETE', url: `/admin/accounts/${child.account_sid}` })).statusCode,
    204,
  );
  assert.equal(
    (await server.app.inject({ method: 'DELETE', url: `/admin/accounts/${accountSid}` })).statusCode,
    204,
  );
  await server.close();
});

/** The Admin panel's suspend button. The parent is fixed, so a PATCH naming one is refused. */
test('a subaccount status is patchable, and its parent is not', async () => {
  const { server, accountSid } = await fixture();
  const child = (
    await server.app.inject({
      method: 'POST',
      url: '/admin/accounts',
      payload: { parent_account_sid: accountSid },
    })
  ).json();

  const patched = await server.app.inject({
    method: 'PATCH',
    url: `/admin/accounts/${child.account_sid}`,
    payload: { status: 'suspended' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().status, 'suspended');

  const reparent = await server.app.inject({
    method: 'PATCH',
    url: `/admin/accounts/${child.account_sid}`,
    payload: { parent_account_sid: accountSid },
  });
  assert.equal(reparent.statusCode, 400, 'reparenting is refused rather than silently dropped');
  await server.close();
});

/**
 * **A seed may list a child before its parent**, which is why `applySeed` links in a
 * second pass. Either order has to produce the same two rows.
 */
test('a seed that lists a subaccount before its parent still links it', async () => {
  const { server } = await fixture();
  const parentSid = `AC${'a'.repeat(32)}`;
  const childSid = `AC${'b'.repeat(32)}`;
  const seeded = await server.app.inject({
    method: 'POST',
    url: '/admin/seed',
    payload: {
      accounts: [
        { account_sid: childSid, friendly_name: 'child', parent_account_sid: parentSid },
        { account_sid: parentSid, friendly_name: 'parent' },
      ],
    },
  });
  assert.equal(seeded.statusCode, 200, seeded.body);

  const child = (await server.app.inject({ url: `/admin/accounts/${childSid}` })).json();
  assert.equal(child.parent_account_sid, parentSid);
  await server.close();
});
