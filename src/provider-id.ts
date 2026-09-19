import { randomBytes } from 'node:crypto';

/**
 * Twilio's id shapes.
 *
 * Thirty-two hex characters after a two-letter prefix, which is what a real one is. An id
 * that only *looks* like Twilio's is the kind of thing that passes every test here and
 * then fails against a real account, so there is one function and every mint goes
 * through it.
 *
 * The prefixes in use: `AC` an account, `CA` a call, `MG` a messaging service, `MZ` a media
 * stream, `SM` a message, `PN` an incoming phone number, `RE` a recording, `SK` an API key.
 */
export function providerId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

/** An auth token is 32 hex characters at Twilio, and nothing here depends on that but the shape. */
export function authToken(): string {
  return randomBytes(16).toString('hex');
}
