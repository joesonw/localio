import { authToken, providerId } from '../provider-id.js';
import { now, type Db } from './open.js';

/**
 * `active` is the only one the REST API will open. See `authenticate()` in
 * `routes/twilio-api.ts`: a `suspended` or `closed` account is a `20005` there, which is
 * the whole reason this is stored rather than merely echoed back.
 */
export type AccountStatus = 'active' | 'suspended' | 'closed';

export interface Account {
  accountSid: string;
  authToken: string;
  friendlyName: string;
  /** The account this one belongs to, or `null` for a top-level account. */
  parentAccountSid: string | null;
  status: AccountStatus;
  createdAt: number;
}

interface Row {
  account_sid: string;
  auth_token: string;
  friendly_name: string;
  parent_account_sid: string | null;
  status: string;
  created_at: number;
}

function hydrate(row: Row): Account {
  return {
    accountSid: row.account_sid,
    authToken: row.auth_token,
    friendlyName: row.friendly_name,
    parentAccountSid: row.parent_account_sid,
    status: row.status as AccountStatus,
    createdAt: row.created_at,
  };
}

/**
 * The accounts this simulator holds, and the tokens it signs their webhooks with.
 *
 * **The sid and the token are minted here and nowhere else.** That is the same rule the
 * other stores hold for `CA…` and `SM…`, for the same reason: a second mint site is a
 * second thing deciding what an identifier is, and the two only ever disagree in
 * production.
 */
export class Accounts {
  constructor(private readonly db: Db) {}

  create(input: {
    friendlyName?: string;
    accountSid?: string;
    authToken?: string;
    parentAccountSid?: string | null;
    status?: AccountStatus;
  }): Account {
    const account: Account = {
      // An explicit sid is accepted so a seed file can pin the one an application under
      // test already has in its own configuration; left out, it is minted.
      accountSid: input.accountSid ?? providerId('AC'),
      authToken: input.authToken ?? authToken(),
      friendlyName: input.friendlyName ?? '',
      // A subaccount is minted exactly like any other account — same prefix, own token.
      // The parent is the only thing that makes it a child.
      parentAccountSid: input.parentAccountSid ?? null,
      status: input.status ?? 'active',
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO accounts (account_sid, auth_token, friendly_name, parent_account_sid, status, created_at)
         VALUES (@accountSid, @authToken, @friendlyName, @parentAccountSid, @status, @createdAt)`,
      )
      .run(account);
    return account;
  }

  /**
   * Create or update in one step, keyed by sid. What the seed file and `/admin/seed` use.
   *
   * **`parentAccountSid` is honoured on create and ignored on update.** Reparenting is not
   * a thing an account does: a child's resources and its credential boundary both hang off
   * the link, and moving it would silently re-scope who can open it.
   */
  upsert(input: {
    accountSid: string;
    authToken?: string;
    friendlyName?: string;
    parentAccountSid?: string | null;
    status?: AccountStatus;
  }): Account {
    const existing = this.find(input.accountSid);
    if (!existing) {
      return this.create(input);
    }
    const next: Account = {
      ...existing,
      authToken: input.authToken ?? existing.authToken,
      friendlyName: input.friendlyName ?? existing.friendlyName,
      status: input.status ?? existing.status,
    };
    this.db
      .prepare(
        `UPDATE accounts SET auth_token = @authToken, friendly_name = @friendlyName, status = @status
         WHERE account_sid = @accountSid`,
      )
      .run(next);
    return next;
  }

  find(accountSid: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE account_sid = ?')
      .get(accountSid) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  list(): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
      .all() as Row[];
    return rows.map(hydrate);
  }

  update(
    accountSid: string,
    patch: { friendlyName?: string; authToken?: string; status?: AccountStatus },
  ): Account | null {
    const existing = this.find(accountSid);
    if (!existing) return null;
    return this.upsert({ accountSid, ...patch });
  }

  /**
   * Link a top-level account to a parent, once.
   *
   * The one place a parent is set after creation, and it exists for the seed: a file may
   * list a child before its parent, so the link is applied in a second pass. **It will not
   * move an account that already has a parent** — the `WHERE` is what makes that true, and
   * it is the same rule `upsert` holds. Answers whether the link was made.
   */
  adopt(accountSid: string, parentAccountSid: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE accounts SET parent_account_sid = ?
         WHERE account_sid = ? AND parent_account_sid IS NULL`,
      )
      .run(parentAccountSid, accountSid);
    return result.changes > 0;
  }

  /** The children of an account, oldest first. A subaccount has none — see migration 3. */
  subaccounts(parentAccountSid: string): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts WHERE parent_account_sid = ? ORDER BY created_at ASC')
      .all(parentAccountSid) as Row[];
    return rows.map(hydrate);
  }

  /** How many children an account has. The delete guard and the Admin panel both want this. */
  subaccountCount(accountSid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM accounts WHERE parent_account_sid = ?')
      .get(accountSid) as { n: number };
    return row.n;
  }

  /** How many numbers an account holds. The delete guard and the UI both want this. */
  numberCount(accountSid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM phone_numbers WHERE account_sid = ?')
      .get(accountSid) as { n: number };
    return row.n;
  }

  /** How many API keys an account holds. The Admin panel's accounts table shows this. */
  keyCount(accountSid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account_sid = ?')
      .get(accountSid) as { n: number };
    return row.n;
  }

  /**
   * Remove an account, but **never one that still holds numbers**.
   *
   * `foreign_keys = ON` would refuse this anyway, with `SQLITE_CONSTRAINT` and nothing
   * naming what was in the way. Checking first is what lets the refusal say how many.
   *
   * **API keys and messaging services go with it**, and numbers do not, because the two
   * are different kinds of thing: a key is a credential *for* this account and a service is
   * configuration *of* it, and neither means anything without it, while a number is a
   * resource with history on it that outlives whoever held it. All are foreign keys into
   * this table, so they have to go in the same transaction or the delete is the opaque
   * `SQLITE_CONSTRAINT` this method exists to avoid. The messages that named a service keep
   * its sid as text, the same way they keep a released number.
   *
   * **A subaccount is neither**, and is not taken along: it is an account in its own
   * right, with its own token and its own numbers, and deleting a parent must not quietly
   * take a second account's history with it. It is released by deleting it first — which
   * is what `'has-subaccounts'` says.
   */
  remove(accountSid: string): 'deleted' | 'not-found' | 'has-numbers' | 'has-subaccounts' {
    if (!this.find(accountSid)) return 'not-found';
    if (this.subaccountCount(accountSid) > 0) return 'has-subaccounts';
    if (this.numberCount(accountSid) > 0) return 'has-numbers';
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM api_keys WHERE account_sid = ?').run(accountSid);
      // Pool rows cascade off this one.
      this.db.prepare('DELETE FROM messaging_services WHERE account_sid = ?').run(accountSid);
      this.db.prepare('DELETE FROM accounts WHERE account_sid = ?').run(accountSid);
    })();
    return 'deleted';
  }
}
