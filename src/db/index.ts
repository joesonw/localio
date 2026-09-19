import { Accounts } from './accounts.js';
import { ApiKeys } from './api-keys.js';
import { Calls } from './calls.js';
import { MessagingServices } from './messaging-services.js';
import { Messages } from './messages.js';
import { PhoneNumbers } from './numbers.js';
import { openDb, type Db, type OpenOptions } from './open.js';
import { Recordings } from './recordings.js';

export * from './accounts.js';
export * from './api-keys.js';
export * from './calls.js';
export * from './messages.js';
export * from './messaging-services.js';
export * from './numbers.js';
export * from './recordings.js';
export { migrate, now, openDb, type Db } from './open.js';

/**
 * The seven stores, over one connection.
 *
 * Everything below the entrypoint takes this rather than a raw `Db`: a query belongs in a
 * store, and a route reaching for SQL of its own is how a second mint site for a sid
 * appears.
 */
export class Store {
  readonly accounts: Accounts;
  readonly apiKeys: ApiKeys;
  readonly numbers: PhoneNumbers;
  readonly calls: Calls;
  readonly messages: Messages;
  readonly messagingServices: MessagingServices;
  readonly recordings: Recordings;

  constructor(readonly db: Db) {
    this.accounts = new Accounts(db);
    this.apiKeys = new ApiKeys(db);
    this.numbers = new PhoneNumbers(db);
    this.calls = new Calls(db);
    this.messages = new Messages(db);
    this.messagingServices = new MessagingServices(db);
    this.recordings = new Recordings(db);
  }

  static open(options: OpenOptions): Store {
    return new Store(openDb(options));
  }

  close(): void {
    this.db.close();
  }
}
