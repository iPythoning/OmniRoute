-- Keep receipts after key deletion so a retry cannot resurrect a credential.
-- Only hashes and identifiers are retained; the existing api_keys table owns the secret.
CREATE TABLE IF NOT EXISTS api_key_issuances (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,
  api_key_id TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
