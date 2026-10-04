-- Amounts are integer nanodollars (USD / 1,000,000,000), never binary floating point.
-- No cascading foreign keys: financial history must survive API key retirement.
CREATE TABLE IF NOT EXISTS prepaid_accounts (
  api_key_id TEXT PRIMARY KEY NOT NULL,
  balance_nanos INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(balance_nanos) = 'integer' AND balance_nanos BETWEEN 0 AND 9007199254740991),
  reserved_nanos INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(reserved_nanos) = 'integer' AND reserved_nanos BETWEEN 0 AND balance_nanos),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prepaid_entries (
  id TEXT PRIMARY KEY NOT NULL,
  api_key_id TEXT NOT NULL REFERENCES prepaid_accounts(api_key_id),
  kind TEXT NOT NULL CHECK(kind IN ('credit', 'charge', 'refund')),
  amount_nanos INTEGER NOT NULL
    CHECK(typeof(amount_nanos) = 'integer' AND amount_nanos BETWEEN 0 AND 9007199254740991),
  reference_id TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prepaid_entries_reference ON prepaid_entries(reference_id, kind);
CREATE INDEX IF NOT EXISTS prepaid_entries_account ON prepaid_entries(api_key_id, created_at);

CREATE TABLE IF NOT EXISTS prepaid_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  api_key_id TEXT NOT NULL REFERENCES prepaid_accounts(api_key_id),
  amount_nanos INTEGER NOT NULL CHECK(typeof(amount_nanos) = 'integer' AND amount_nanos BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('held', 'dispatched', 'settled', 'released')),
  billing_context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prepaid_reservations_account ON prepaid_reservations(api_key_id, state);
