type FinancialStateReader = {
  prepare(sql: string): { get(...args: unknown[]): unknown };
};

export class FinancialStateRecoveryError extends Error {
  constructor() {
    super("Financial state requires a complete database restore");
  }
}

export function hasFinancialState(db: FinancialStateReader): boolean {
  for (const table of [
    "api_key_issuances",
    "prepaid_accounts",
    "prepaid_entries",
    "prepaid_reservations",
  ]) {
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) &&
      db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    )
      return true;
  }
  return false;
}
