import { createHmac } from 'node:crypto';

/**
 * Twilio's request signature, from the signing end.
 *
 * The application under test verifies with `twilio.validateRequest` (or its own copy of
 * that scheme); this app signs. The two have to agree exactly or **every** webhook this
 * app sends is refused as forged — a blanket 403 that reads as an attack, with nothing in
 * any log naming the character that differed. That is why this is a pure function with a
 * test that runs the real SDK's verifier against its output.
 *
 * The scheme, which is Twilio's and is not negotiable:
 *
 * 1. Start with **the exact URL the request is made to**, query string included. Unlike
 *    the app this was extracted from, `localio` signs and posts to the same string — the
 *    number's own `voice_url` — so there is no way for the two to drift apart.
 * 2. Append every POST parameter, **sorted by name**, each key immediately followed by
 *    its value and nothing between them.
 * 3. HMAC-SHA1 that string with the account's auth token, base64.
 *
 * The whole body is signed, so a field added to the form and left out of this — or the
 * other way round — invalidates it. Both come from one map for that reason.
 */
export function signRequest(
  token: string,
  url: string,
  params: Record<string, string>,
): string {
  // `sort()` on the keys, not on entries: Twilio sorts by parameter name, and a sort
  // that happened to consider the value would agree with this one on every body that
  // has no duplicate keys and disagree on exactly the ones that do.
  let payload = url;
  for (const key of Object.keys(params).sort()) {
    payload += key + (params[key] ?? '');
  }
  return createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
}

/** The header Twilio sends it under. Lower-case, because that is how it arrives. */
export const SIGNATURE_HEADER = 'x-twilio-signature';
