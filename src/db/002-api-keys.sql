-- localio, migration 2. API keys: a second credential for an account.
--
-- Configuration, not history, so it carries a real foreign key the way `phone_numbers`
-- does. The secret is plaintext for the same reason `accounts.auth_token` is: there is no
-- encryption key here and no secret that is not a row — localio *is* the account holder,
-- and a hash would only mean the one place the secret has to be pasted from could not
-- show it twice.
CREATE TABLE api_keys (
  sid           TEXT PRIMARY KEY,          -- SK + 32 hex
  account_sid   TEXT NOT NULL REFERENCES accounts(account_sid),
  secret        TEXT NOT NULL,             -- what a client sends as the Basic password
  friendly_name TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX api_keys_account ON api_keys(account_sid);
