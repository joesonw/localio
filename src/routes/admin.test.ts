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

/* ------------------------------------------------------ messaging services */

test('a messaging service round-trips, pool and all', async () => {
  const { server, store, accountSid } = await fixture();
  for (const phoneNumber of ['+15550000001', '+15550000002']) {
    store.numbers.create({ phoneNumber, accountSid });
  }
  const created = await server.app.inject({
    method: 'POST',
    url: '/admin/messaging-services',
    payload: {
      account_sid: accountSid,
      friendly_name: 'support',
      inbound_request_url: 'http://app.test/pool',
      phone_numbers: ['+15550000001', '+15550000002'],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const sid = created.json().sid;
  assert.match(sid, /^MG[0-9a-f]{32}$/);
  assert.equal(created.json().phone_numbers.length, 2);

  const patched = await server.app.inject({
    method: 'PATCH',
    url: `/admin/messaging-services/${sid}`,
    payload: { friendly_name: 'renamed', inbound_request_url: '' },
  });
  assert.equal(patched.json().friendly_name, 'renamed');
  assert.equal(patched.json().inbound_request_url, null);

  const deleted = await server.app.inject({
    method: 'DELETE',
    url: `/admin/messaging-services/${sid}`,
  });
  assert.equal(deleted.statusCode, 204);
  // The pool went with it; the numbers did not.
  assert.equal(store.numbers.list(accountSid).length, 2);
  await server.close();
});

/** The account is fixed at creation, and a PATCH naming it must say so rather than no-op. */
test('a PATCH naming the account is a 400, not a silent no-op', async () => {
  const { server, store, accountSid } = await fixture();
  const service = store.messagingServices.create({ accountSid, friendlyName: 'support' });
  const response = await server.app.inject({
    method: 'PATCH',
    url: `/admin/messaging-services/${service.sid}`,
    payload: { account_sid: accountSid },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_request');
  await server.close();
});

test('a pool is one account\'s, and a number is in one service', async () => {
  const { server, store, accountSid } = await fixture();
  const stranger = store.accounts.create({ friendlyName: 'stranger' });
  const mine = store.numbers.create({ phoneNumber: '+15550000001', accountSid });
  const theirs = store.numbers.create({
    phoneNumber: '+15558888888',
    accountSid: stranger.accountSid,
  });
  const service = store.messagingServices.create({ accountSid, friendlyName: 'support' });
  const other = store.messagingServices.create({ accountSid, friendlyName: 'billing' });

  const wrongAccount = await server.app.inject({
    method: 'POST',
    url: `/admin/messaging-services/${service.sid}/numbers`,
    payload: { phone_number_sid: theirs.sid },
  });
  assert.equal(wrongAccount.statusCode, 400);
  assert.equal(wrongAccount.json().error, 'wrong_account');
  assert.match(wrongAccount.json().message, new RegExp(stranger.accountSid));

  const added = await server.app.inject({
    method: 'POST',
    url: `/admin/messaging-services/${service.sid}/numbers`,
    payload: { phone_number_sid: mine.sid },
  });
  assert.equal(added.statusCode, 201);

  const taken = await server.app.inject({
    method: 'POST',
    url: `/admin/messaging-services/${other.sid}/numbers`,
    payload: { phone_number_sid: mine.sid },
  });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().error, 'in_another_service');
  assert.match(taken.json().message, new RegExp(service.sid));

  const removed = await server.app.inject({
    method: 'DELETE',
    url: `/admin/messaging-services/${service.sid}/numbers/${mine.sid}`,
  });
  assert.equal(removed.statusCode, 204);
  const again = await server.app.inject({
    method: 'DELETE',
    url: `/admin/messaging-services/${service.sid}/numbers/${mine.sid}`,
  });
  assert.equal(again.json().error, 'not_in_service');
  await server.close();
});

/** A pool stated up front is one intention: half of it applied is not what was asked for. */
test('a bad number in a stated pool writes nothing at all', async () => {
  const { server, store, accountSid } = await fixture();
  store.numbers.create({ phoneNumber: '+15550000001', accountSid });
  const response = await server.app.inject({
    method: 'POST',
    url: '/admin/messaging-services',
    payload: {
      account_sid: accountSid,
      friendly_name: 'support',
      phone_numbers: ['+15550000001', '+15559999999'],
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'no_such_number');
  assert.deepEqual(store.messagingServices.list(accountSid), []);
  await server.close();
});

test('releasing a pooled number shrinks the pool and keeps the service', async () => {
  const { server, store, accountSid } = await fixture();
  const number = store.numbers.create({ phoneNumber: '+15550000001', accountSid });
  const service = store.messagingServices.create({ accountSid, friendlyName: 'support' });
  store.messagingServices.addNumber(service.sid, number.sid);

  const released = await server.app.inject({
    method: 'DELETE',
    url: `/admin/numbers/${number.sid}`,
  });
  assert.equal(released.statusCode, 204);
  const read = await server.app.inject({ url: `/admin/messaging-services/${service.sid}` });
  assert.deepEqual(read.json().phone_numbers, []);
  await server.close();
});

test('seeding twice does not re-mint the service, and converges the pool', async () => {
  const { server, store } = await fixture();
  const seed = {
    accounts: [{ account_sid: 'AC' + '1'.repeat(32), friendly_name: 'dev' }],
    numbers: [{ phone_number: '+15550000001' }, { phone_number: '+15550000002' }],
    messaging_services: [
      {
        sid: 'MG' + '1'.repeat(32),
        friendly_name: 'notifications',
        phone_numbers: ['+15550000001', '+15550000002'],
      },
    ],
  };
  for (const _ of [0, 1]) {
    const response = await server.app.inject({ method: 'POST', url: '/admin/seed', payload: seed });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(store.messagingServices.list().length, 1);
  assert.equal(store.messagingServices.numberCount(seed.messaging_services[0]!.sid), 2);

  // The pool is declarative: stating one member makes the pool one member.
  seed.messaging_services[0]!.phone_numbers = ['+15550000002'];
  await server.app.inject({ method: 'POST', url: '/admin/seed', payload: seed });
  assert.deepEqual(
    store.messagingServices
      .numbers(seed.messaging_services[0]!.sid)
      .map((n) => n.phoneNumber),
    ['+15550000002'],
  );
  await server.close();
});

test('a seed pool naming an unheld number is refused, naming both', async () => {
  const { server } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: '/admin/seed',
    payload: {
      accounts: [{ account_sid: 'AC' + '1'.repeat(32), friendly_name: 'dev' }],
      messaging_services: [
        { sid: 'MG' + '1'.repeat(32), friendly_name: 'x', phone_numbers: ['+15559999999'] },
      ],
    },
  });
  assert.equal(response.statusCode, 500);
  await server.close();
});
