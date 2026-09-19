import { providerId } from '../provider-id.js';
import { now, type Db } from './open.js';

export interface PhoneNumber {
  sid: string;
  accountSid: string;
  phoneNumber: string;
  friendlyName: string;
  voiceUrl: string | null;
  voiceMethod: string;
  statusCallbackUrl: string | null;
  statusCallbackMethod: string;
  smsUrl: string | null;
  smsMethod: string;
  createdAt: number;
}

interface Row {
  sid: string;
  account_sid: string;
  phone_number: string;
  friendly_name: string;
  voice_url: string | null;
  voice_method: string;
  status_callback_url: string | null;
  status_callback_method: string;
  sms_url: string | null;
  sms_method: string;
  created_at: number;
}

function hydrate(row: Row): PhoneNumber {
  return {
    sid: row.sid,
    accountSid: row.account_sid,
    phoneNumber: row.phone_number,
    friendlyName: row.friendly_name,
    voiceUrl: row.voice_url,
    voiceMethod: row.voice_method,
    statusCallbackUrl: row.status_callback_url,
    statusCallbackMethod: row.status_callback_method,
    smsUrl: row.sms_url,
    smsMethod: row.sms_method,
    createdAt: row.created_at,
  };
}

export interface NumberInput {
  phoneNumber: string;
  accountSid: string;
  sid?: string;
  friendlyName?: string;
  voiceUrl?: string | null;
  voiceMethod?: string;
  statusCallbackUrl?: string | null;
  statusCallbackMethod?: string;
  smsUrl?: string | null;
  smsMethod?: string;
}

/** Everything a `PATCH` may change. The number itself and its account are not on this list. */
export type NumberPatch = Omit<Partial<NumberInput>, 'phoneNumber' | 'sid'>;

/** How many candidates `createInAreaCode` draws before it gives up. */
const ATTEMPTS = 20;

/**
 * A NANP line in `areaCode`: `+1` NPA NXX XXXX, with the exchange starting 2-9.
 *
 * Eight million per area code, which is what makes the retry in `createInAreaCode` a
 * formality rather than a loop anybody waits on. `rand` is a seam for the test that has
 * to make a collision happen on purpose.
 */
export function nanpNumber(areaCode: string, rand: () => number = Math.random): string {
  const exchange = 200 + Math.floor(rand() * 800);
  const line = Math.floor(rand() * 10000);
  return `+1${areaCode}${exchange}${String(line).padStart(4, '0')}`;
}

/**
 * The numbers this simulator answers for, and the URLs it calls when one is dialled or
 * texted.
 *
 * **A number's `voice_url` is both the URL a webhook is posted to and the URL its
 * signature is computed over**, which is Twilio's own arrangement. The app this was
 * extracted from kept those as two settings — one to sign against, one to send to — and
 * the whole of its "when every webhook comes back 403" documentation exists because they
 * could disagree. One column cannot.
 */
export class PhoneNumbers {
  constructor(private readonly db: Db) {}

  create(input: NumberInput): PhoneNumber {
    const record: PhoneNumber = {
      sid: input.sid ?? providerId('PN'),
      accountSid: input.accountSid,
      phoneNumber: input.phoneNumber,
      friendlyName: input.friendlyName ?? '',
      voiceUrl: input.voiceUrl ?? null,
      voiceMethod: input.voiceMethod ?? 'POST',
      statusCallbackUrl: input.statusCallbackUrl ?? null,
      statusCallbackMethod: input.statusCallbackMethod ?? 'POST',
      smsUrl: input.smsUrl ?? null,
      smsMethod: input.smsMethod ?? 'POST',
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO phone_numbers (
           sid, account_sid, phone_number, friendly_name,
           voice_url, voice_method, status_callback_url, status_callback_method,
           sms_url, sms_method, created_at
         ) VALUES (
           @sid, @accountSid, @phoneNumber, @friendlyName,
           @voiceUrl, @voiceMethod, @statusCallbackUrl, @statusCallbackMethod,
           @smsUrl, @smsMethod, @createdAt
         )`,
      )
      .run(record);
    return record;
  }

  /**
   * Provision *some* unheld number in `areaCode`, or `null` if it could not find one.
   *
   * **The UNIQUE constraint on `phone_number` is the guarantee here, not a lookup before
   * the insert.** Generating a candidate, asking `findByNumber` about it and inserting it
   * afterwards is a window this does not need to have, and it duplicates a promise SQLite
   * already keeps. A collision is caught and redrawn; running out of draws is what `null`
   * means, and the route turns that into Twilio's "no numbers available".
   *
   * The friendly name falls back to the number, which is the same default the E.164 path
   * uses — but only this side knows the number in time to apply it.
   */
  createInAreaCode(
    areaCode: string,
    input: Omit<NumberInput, 'phoneNumber'>,
    rand?: () => number,
  ): PhoneNumber | null {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const phoneNumber = nanpNumber(areaCode, rand);
      try {
        return this.create({ ...input, phoneNumber, friendlyName: input.friendlyName ?? phoneNumber });
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      }
    }
    return null;
  }

  /** Create or update, keyed by the **number** rather than by the sid — a seed file names numbers. */
  upsert(input: NumberInput): PhoneNumber {
    const existing = this.findByNumber(input.phoneNumber);
    if (!existing) return this.create(input);
    return this.update(existing.sid, input) ?? existing;
  }

  find(sid: string): PhoneNumber | null {
    const row = this.db.prepare('SELECT * FROM phone_numbers WHERE sid = ?').get(sid) as
      | Row
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** The lookup every inbound call and message makes. E.164, matched exactly. */
  findByNumber(phoneNumber: string): PhoneNumber | null {
    const row = this.db
      .prepare('SELECT * FROM phone_numbers WHERE phone_number = ?')
      .get(phoneNumber) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  list(accountSid?: string): PhoneNumber[] {
    const rows = (
      accountSid
        ? this.db
            .prepare('SELECT * FROM phone_numbers WHERE account_sid = ? ORDER BY phone_number')
            .all(accountSid)
        : this.db.prepare('SELECT * FROM phone_numbers ORDER BY phone_number').all()
    ) as Row[];
    return rows.map(hydrate);
  }

  /**
   * A partial update: every field left out of `patch` keeps the value it had.
   *
   * `undefined` means "not mentioned" and `null` means "clear it", which is the
   * distinction the webhook-URL fields need — an in-place edit that blanked a box is
   * asking for `null`, and one that never rendered the box is asking for neither.
   */
  update(sid: string, patch: NumberPatch): PhoneNumber | null {
    const existing = this.find(sid);
    if (!existing) return null;
    const next: PhoneNumber = {
      ...existing,
      accountSid: patch.accountSid ?? existing.accountSid,
      friendlyName: patch.friendlyName ?? existing.friendlyName,
      voiceUrl: patch.voiceUrl === undefined ? existing.voiceUrl : patch.voiceUrl,
      voiceMethod: patch.voiceMethod ?? existing.voiceMethod,
      statusCallbackUrl:
        patch.statusCallbackUrl === undefined
          ? existing.statusCallbackUrl
          : patch.statusCallbackUrl,
      statusCallbackMethod: patch.statusCallbackMethod ?? existing.statusCallbackMethod,
      smsUrl: patch.smsUrl === undefined ? existing.smsUrl : patch.smsUrl,
      smsMethod: patch.smsMethod ?? existing.smsMethod,
    };
    this.db
      .prepare(
        `UPDATE phone_numbers SET
           account_sid = @accountSid, friendly_name = @friendlyName,
           voice_url = @voiceUrl, voice_method = @voiceMethod,
           status_callback_url = @statusCallbackUrl,
           status_callback_method = @statusCallbackMethod,
           sms_url = @smsUrl, sms_method = @smsMethod
         WHERE sid = @sid`,
      )
      .run(next);
    return next;
  }

  /**
   * Remove a number. **The history stays.**
   *
   * `calls`, `messages` and `recordings` carry the numbers as text, not as a foreign key,
   * precisely so this is possible: releasing a number is a change to what the simulator
   * answers for from now on, and is not a reason to lose the record of what happened on
   * it. `usage` is what lets the confirm say how much that is.
   */
  remove(sid: string): boolean {
    return this.db.prepare('DELETE FROM phone_numbers WHERE sid = ?').run(sid).changes > 0;
  }

  usage(phoneNumber: string): { calls: number; messages: number } {
    const calls = this.db
      .prepare('SELECT COUNT(*) AS n FROM calls WHERE from_number = ? OR to_number = ?')
      .get(phoneNumber, phoneNumber) as { n: number };
    const messages = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE from_number = ? OR to_number = ?')
      .get(phoneNumber, phoneNumber) as { n: number };
    return { calls: calls.n, messages: messages.n };
  }
}
