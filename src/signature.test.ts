import assert from 'node:assert/strict';
import { test } from 'node:test';
import twilio from 'twilio';
import { signRequest } from './signature.js';

/**
 * **The most important test here.**
 *
 * Everything else in this app is visible in the event log when it breaks. This fails as a
 * blanket 403 at the far end, with nothing anywhere naming the character that differed,
 * and the symptom — "everything is forged" — reads as an attack rather than as a bug.
 *
 * So it is asserted against `twilio.validateRequest`: the real SDK's verifier, the
 * function an application under test actually calls. Not against a frozen vector, which
 * would only prove this file agrees with itself.
 *
 * `twilio` is a **devDependency** and must never become a runtime one. This app is an
 * independent implementation of that wire on purpose — sharing the code would let a bug
 * agree with itself on both sides.
 */

const TOKEN = '12345678901234567890123456789012';

function check(url: string, params: Record<string, string>): void {
  assert.ok(
    twilio.validateRequest(TOKEN, signRequest(TOKEN, url, params), url, params),
    `the real verifier rejected what we signed for ${url}`,
  );
}

test('a voice webhook is accepted by the real verifier', () => {
  check('https://app.example.com/voice', {
    CallSid: 'CA00000000000000000000000000000001',
    AccountSid: 'AC00000000000000000000000000000001',
    From: '+15551110000',
    To: '+15552220000',
    Caller: '+15551110000',
    Called: '+15552220000',
    Direction: 'inbound',
    CallStatus: 'ringing',
    ApiVersion: '2010-04-01',
  });
});

test('a messaging webhook is accepted by the real verifier', () => {
  check('https://app.example.com/sms', {
    MessageSid: 'SM00000000000000000000000000000001',
    SmsSid: 'SM00000000000000000000000000000001',
    SmsMessageSid: 'SM00000000000000000000000000000001',
    AccountSid: 'AC00000000000000000000000000000001',
    From: '+15551110000',
    To: '+15552220000',
    Body: 'hello, world',
    NumMedia: '0',
    NumSegments: '1',
    ApiVersion: '2010-04-01',
  });
});

/**
 * **A query string is part of the signature.**
 *
 * An application routes on its own query parameters — an agent id, a job id — so a
 * `<Record action>` or a placement's `Url` frequently carries one. Signing the bare path
 * and posting to the full URL, or the reverse, is a blanket 403 on exactly the
 * configurations that matter most.
 */
test('a url with a query string signs over the query too', () => {
  check('https://app.example.com/voice?agent_id=agt_42&mode=test', {
    CallSid: 'CA00000000000000000000000000000001',
    From: '+15551110000',
  });
});

/** Values that need escaping on the wire are signed **unescaped**, which is Twilio's rule. */
test('bodies with spaces, plus signs and unicode are accepted', () => {
  check('https://app.example.com/sms', {
    Body: 'a + b, "quoted" & spaced — ünïcøde 😀',
    From: '+15551110000',
    To: '+15552220000',
  });
});

/** Sorted by **key**, not by entry — a sort that considered the value agrees on most bodies. */
test('parameter order in the object does not change the signature', () => {
  const url = 'https://app.example.com/voice';
  const a = signRequest(TOKEN, url, { Zeta: '1', Alpha: '2', Mu: '3' });
  const b = signRequest(TOKEN, url, { Mu: '3', Zeta: '1', Alpha: '2' });
  assert.equal(a, b);
});

test('an empty body still signs the url', () => {
  check('https://app.example.com/status?call=CA1', {});
});

/** The negative: a body the signature did not cover must not verify. */
test('a changed parameter invalidates the signature', () => {
  const url = 'https://app.example.com/voice';
  const signature = signRequest(TOKEN, url, { From: '+15551110000' });
  assert.equal(twilio.validateRequest(TOKEN, signature, url, { From: '+15559999999' }), false);
});

test('a changed url invalidates the signature', () => {
  const signature = signRequest(TOKEN, 'https://app.example.com/voice', { A: '1' });
  assert.equal(
    twilio.validateRequest(TOKEN, signature, 'https://app.example.com/voice2', { A: '1' }),
    false,
  );
});
