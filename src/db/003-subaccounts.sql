-- localio, migration 3. Subaccounts: an account that belongs to another account.
--
-- A subaccount is a *full* account — its own `AC…`, its own auth token, its own numbers
-- and keys — that a parent's credentials may also open. That is Twilio's shape, and it is
-- why this is two columns on `accounts` rather than a table of its own: everything that
-- already takes an `account_sid` keeps working, because a child is an account.
--
-- `parent_account_sid` is nullable and self-referencing: NULL is a top-level account. Only
-- one level is allowed — a child never parents another — but that rule lives in the routes
-- rather than here, because SQLite cannot express it and a CHECK that could would still
-- not say *why* when it fired.
ALTER TABLE accounts ADD COLUMN parent_account_sid TEXT REFERENCES accounts(account_sid);

-- active | suspended | closed. Anything but `active` is refused at the REST API's Basic
-- auth, which is what makes the field worth storing rather than merely echoing.
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX accounts_parent ON accounts(parent_account_sid);
