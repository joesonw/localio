import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallClaims } from './call-claims.js';

/**
 * The claim is a **hint**, and these are the properties that keep it one.
 *
 * Every failure here is silent somewhere else: a claim that cannot be re-taken by its own
 * holder strands a retrying page; a claim that never expires makes a crashed tab a wall no
 * other tab can get past; a `release` that does not check its holder lets a lapsed claimant
 * take the call out from under whoever has it now.
 *
 * The clock is injected so none of this waits on real time.
 */

function fixture(ttlMs = 1000): { claims: CallClaims; tick: (ms: number) => void } {
  let clock = 1_000_000;
  const claims = new CallClaims(ttlMs, () => clock);
  return { claims, tick: (ms) => { clock += ms; } };
}

test('the first holder gets it and the second is refused', () => {
  const { claims } = fixture();
  assert.equal(claims.claim('CA1', 'tab-a'), true);
  assert.equal(claims.claim('CA1', 'tab-b'), false);
  assert.equal(claims.heldBy('CA1'), 'tab-a');
});

test('the same holder can re-take its own claim', () => {
  const { claims, tick } = fixture();
  claims.claim('CA1', 'tab-a');
  tick(500);
  // A retry after a dropped socket is the same person still picking up the same call —
  // and it renews, so the retry does not inherit what is left of the first TTL.
  assert.equal(claims.claim('CA1', 'tab-a'), true);
  tick(600);
  assert.equal(claims.heldBy('CA1'), 'tab-a');
});

test('a claim expires, and then anybody can have it', () => {
  const { claims, tick } = fixture();
  claims.claim('CA1', 'tab-a');
  tick(1001);
  // The tab that claimed and died is not coming back to release it.
  assert.equal(claims.heldBy('CA1'), null);
  assert.equal(claims.claim('CA1', 'tab-b'), true);
});

test('releasing a claim you do not hold does nothing', () => {
  const { claims, tick } = fixture();
  claims.claim('CA1', 'tab-a');
  tick(1001);
  claims.claim('CA1', 'tab-b');
  // `tab-a`'s claim lapsed and `tab-b` has it now. A late release from `tab-a` must not
  // reach in and free somebody else's call.
  claims.release('CA1', 'tab-a');
  assert.equal(claims.heldBy('CA1'), 'tab-b');
  claims.release('CA1', 'tab-b');
  assert.equal(claims.heldBy('CA1'), null);
});

test('releasing without a holder is unconditional — that is what declining does', () => {
  const { claims } = fixture();
  claims.claim('CA1', 'tab-a');
  claims.release('CA1');
  assert.equal(claims.heldBy('CA1'), null);
});

test('claims do not leak across sids', () => {
  const { claims } = fixture();
  claims.claim('CA1', 'tab-a');
  assert.equal(claims.heldBy('CA2'), null);
  assert.equal(claims.claim('CA2', 'tab-b'), true);
});

test('expiresAt is null once the claim has lapsed', () => {
  const { claims, tick } = fixture();
  claims.claim('CA1', 'tab-a');
  assert.equal(claims.expiresAt('CA1'), 1_001_000);
  tick(1001);
  assert.equal(claims.expiresAt('CA1'), null);
});
