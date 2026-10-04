import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { getDbInstance } from "./core";
import { getDurableDbInstance } from "./durable";

// Storage/wire denomination, not a configurable price or spending policy.
const USD_NANOS = 1_000_000_000n;
const amountSchema = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,9})?$/);
const idSchema = z.string().uuid();

export class PrepaidError extends Error {
  constructor(
    readonly code:
      "not_found" | "conflict" | "insufficient_funds" | "invalid_amount" | "unavailable"
  ) {
    super(`Prepaid operation failed: ${code}`);
  }
}

export function parseUsdNanos(value: string): number {
  if (!amountSchema.safeParse(value).success) throw new PrepaidError("invalid_amount");
  const [whole, fraction = ""] = value.split(".");
  const nanos = BigInt(whole) * USD_NANOS + BigInt(fraction.padEnd(9, "0"));
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER)) throw new PrepaidError("invalid_amount");
  return Number(nanos);
}

export function formatUsdNanos(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new PrepaidError("invalid_amount");
  const nanos = BigInt(value);
  return `${nanos / USD_NANOS}.${String(nanos % USD_NANOS).padStart(9, "0")}`;
}

type Account = { api_key_id: string; balance_nanos: number; reserved_nanos: number };
type Entry = {
  id: string;
  api_key_id: string;
  kind: string;
  amount_nanos: number;
  reference_id: string | null;
  evidence: string | null;
};
type Reservation = {
  id: string;
  api_key_id: string;
  amount_nanos: number;
  state: "held" | "dispatched" | "settled" | "released";
  billing_context: string | null;
};

function database() {
  try {
    return getDurableDbInstance();
  } catch {
    throw new PrepaidError("unavailable");
  }
}

function account(apiKeyId: string): Account | undefined {
  if (getDbInstance().name === ":memory:") return undefined;
  return getDbInstance()
    .prepare(
      "SELECT api_key_id, balance_nanos, reserved_nanos FROM prepaid_accounts WHERE api_key_id = ?"
    )
    .get(apiKeyId) as Account | undefined;
}

function reservation(id: string): Reservation {
  idSchema.parse(id);
  const row = database().prepare("SELECT * FROM prepaid_reservations WHERE id = ?").get(id) as
    Reservation | undefined;
  if (!row) throw new PrepaidError("not_found");
  return row;
}

function entry(id: string): Entry | undefined {
  return database().prepare("SELECT * FROM prepaid_entries WHERE id = ?").get(id) as
    Entry | undefined;
}

function matchesEntry(
  row: Entry,
  apiKeyId: string,
  kind: string,
  amount: number,
  reference: string | null,
  evidence: string | null = null
) {
  if (
    row.api_key_id !== apiKeyId ||
    row.kind !== kind ||
    row.amount_nanos !== amount ||
    row.reference_id !== reference ||
    row.evidence !== evidence
  ) {
    throw new PrepaidError("conflict");
  }
}

function addEntry(
  id: string,
  apiKeyId: string,
  kind: string,
  amount: number,
  reference: string | null,
  evidence: string | null = null
) {
  database()
    .prepare(
      `INSERT INTO prepaid_entries (id, api_key_id, kind, amount_nanos, reference_id, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, apiKeyId, kind, amount, reference, evidence, new Date().toISOString());
}

export function getPrepaidBalance(apiKeyId: string) {
  const row = account(apiKeyId);
  if (!row) return null;
  database();
  return {
    apiKeyId,
    balanceUsd: formatUsdNanos(row.balance_nanos),
    reservedUsd: formatUsdNanos(row.reserved_nanos),
    availableUsd: formatUsdNanos(row.balance_nanos - row.reserved_nanos),
  };
}

export function createPrepaidAccount(apiKeyId: string): void {
  idSchema.parse(apiKeyId);
  const db = database();
  db.immediate(() => {
    if (!db.prepare("SELECT id FROM api_keys WHERE id = ?").get(apiKeyId))
      throw new PrepaidError("not_found");
    db.prepare("INSERT OR IGNORE INTO prepaid_accounts (api_key_id, created_at) VALUES (?, ?)").run(
      apiKeyId,
      new Date().toISOString()
    );
  });
}

function assertNotReservation(id: string): void {
  if (database().prepare("SELECT id FROM prepaid_reservations WHERE id = ?").get(id))
    throw new PrepaidError("conflict");
}

export function creditPrepaid(apiKeyId: string, entryId: string, amountUsd: string) {
  idSchema.parse(apiKeyId);
  idSchema.parse(entryId);
  const amount = parseUsdNanos(amountUsd);
  if (amount === 0) throw new PrepaidError("invalid_amount");
  const db = database();
  db.immediate(() => {
    const previous = entry(entryId);
    if (previous) return matchesEntry(previous, apiKeyId, "credit", amount, null);
    assertNotReservation(entryId);
    if (!db.prepare("SELECT id FROM api_keys WHERE id = ?").get(apiKeyId))
      throw new PrepaidError("not_found");
    db.prepare("INSERT OR IGNORE INTO prepaid_accounts (api_key_id, created_at) VALUES (?, ?)").run(
      apiKeyId,
      new Date().toISOString()
    );
    const row = account(apiKeyId)!;
    if (!Number.isSafeInteger(row.balance_nanos + amount)) throw new PrepaidError("invalid_amount");
    db.prepare(
      "UPDATE prepaid_accounts SET balance_nanos = balance_nanos + ? WHERE api_key_id = ?"
    ).run(amount, apiKeyId);
    addEntry(entryId, apiKeyId, "credit", amount, null);
  });
  return getPrepaidBalance(apiKeyId)!;
}

export function reservePrepaid(
  apiKeyId: string,
  reservationId: string,
  maximumUsd: string,
  billingContext?: Record<string, unknown>
) {
  idSchema.parse(apiKeyId);
  idSchema.parse(reservationId);
  const amount = parseUsdNanos(maximumUsd);
  const context = billingContext ? JSON.stringify(billingContext) : null;
  const db = database();
  let replayed = false;
  db.immediate(() => {
    const previous = db
      .prepare("SELECT * FROM prepaid_reservations WHERE id = ?")
      .get(reservationId) as Reservation | undefined;
    if (previous) {
      if (
        previous.api_key_id !== apiKeyId ||
        previous.amount_nanos !== amount ||
        !isDeepStrictEqual(
          previous.billing_context ? JSON.parse(previous.billing_context) : null,
          context ? JSON.parse(context) : null
        )
      )
        throw new PrepaidError("conflict");
      replayed = true;
      return;
    }
    if (entry(reservationId)) throw new PrepaidError("conflict");
    if (!account(apiKeyId)) throw new PrepaidError("not_found");
    const liveKey = db
      .prepare(`SELECT is_active, is_banned, revoked_at, expires_at FROM api_keys WHERE id = ?`)
      .get(apiKeyId) as
      | {
          is_active: number;
          is_banned: number;
          revoked_at: string | null;
          expires_at: string | null;
        }
      | undefined;
    if (
      !liveKey ||
      !liveKey.is_active ||
      liveKey.is_banned ||
      liveKey.revoked_at ||
      (liveKey.expires_at && Date.parse(liveKey.expires_at) <= Date.now())
    )
      throw new PrepaidError("conflict");
    const updated = db
      .prepare(
        `UPDATE prepaid_accounts SET reserved_nanos = reserved_nanos + ?
      WHERE api_key_id = ? AND balance_nanos - reserved_nanos >= ?`
      )
      .run(amount, apiKeyId, amount);
    if (!updated.changes) throw new PrepaidError("insufficient_funds");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO prepaid_reservations (id, api_key_id, amount_nanos, state, billing_context, created_at, updated_at)
      VALUES (?, ?, ?, 'held', ?, ?, ?)`
    ).run(reservationId, apiKeyId, amount, context, now, now);
  });
  return { ...reservation(reservationId), replayed };
}

// The caller must commit this transition BEFORE contacting the provider. A replay never dispatches twice.
export function dispatchPrepaid(reservationId: string): void {
  idSchema.parse(reservationId);
  const changed = database()
    .prepare(
      `UPDATE prepaid_reservations SET state = 'dispatched', updated_at = ?
    WHERE id = ? AND state = 'held'`
    )
    .run(new Date().toISOString(), reservationId);
  if (!changed.changes) throw new PrepaidError("conflict");
}

export function settlePrepaid(
  reservationId: string,
  actualUsd: string,
  evidence: string | null = null
) {
  const amount = parseUsdNanos(actualUsd);
  const db = database();
  let apiKeyId: string;
  db.immediate(() => {
    const held = reservation(reservationId);
    apiKeyId = held.api_key_id;
    const previous = entry(reservationId);
    if (previous)
      return matchesEntry(previous, apiKeyId, "charge", amount, reservationId, evidence);
    if (held.state !== "dispatched" && !(held.state === "held" && evidence && amount === 0))
      throw new PrepaidError("conflict");
    // A broken upstream bound must remain visibly unresolved, never consume another request's reservation.
    if (amount > held.amount_nanos) throw new PrepaidError("insufficient_funds");
    db.prepare(
      `UPDATE prepaid_accounts SET balance_nanos = balance_nanos - ?, reserved_nanos = reserved_nanos - ?
      WHERE api_key_id = ?`
    ).run(amount, held.amount_nanos, apiKeyId);
    addEntry(reservationId, apiKeyId, "charge", amount, reservationId, evidence);
    db.prepare(
      "UPDATE prepaid_reservations SET state = 'settled', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), reservationId);
  });
  return getPrepaidBalance(apiKeyId!)!;
}

export function listPrepaidEntries(apiKeyId: string, limit: number, after: number) {
  idSchema.parse(apiKeyId);
  z.number().int().min(1).max(100).parse(limit);
  z.number().int().nonnegative().parse(after);
  const rows = database()
    .prepare(
      "SELECT rowid AS cursor, * FROM prepaid_entries WHERE api_key_id = ? AND rowid > ? ORDER BY rowid LIMIT ?"
    )
    .all(apiKeyId, after, limit) as Array<Entry & { cursor: number; created_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    cursor: row.cursor,
    kind: row.kind,
    amountUsd: formatUsdNanos(row.amount_nanos),
    referenceId: row.reference_id,
    evidence: row.evidence,
    createdAt: row.created_at,
  }));
}

export function listPrepaidReservations(apiKeyId: string, limit: number, after: number) {
  idSchema.parse(apiKeyId);
  z.number().int().min(1).max(100).parse(limit);
  z.number().int().nonnegative().parse(after);
  const rows = database()
    .prepare(
      `SELECT rowid AS cursor, * FROM prepaid_reservations
    WHERE api_key_id = ? AND rowid > ? AND state IN ('held', 'dispatched') ORDER BY rowid LIMIT ?`
    )
    .all(apiKeyId, after, limit) as Array<
    Reservation & {
      cursor: number;
      billing_context: string | null;
      created_at: string;
      updated_at: string;
    }
  >;
  return rows.map((row) => ({
    id: row.id,
    cursor: row.cursor,
    state: row.state,
    amountUsd: formatUsdNanos(row.amount_nanos),
    billingContext: row.billing_context ? JSON.parse(row.billing_context) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// Only undispatched reservations can be released automatically. Ambiguous provider outcomes keep their hold.
export function releasePrepaid(reservationId: string): void {
  const db = database();
  db.immediate(() => {
    const held = reservation(reservationId);
    if (held.state === "released") return;
    if (held.state !== "held") throw new PrepaidError("conflict");
    db.prepare(
      "UPDATE prepaid_accounts SET reserved_nanos = reserved_nanos - ? WHERE api_key_id = ?"
    ).run(held.amount_nanos, held.api_key_id);
    db.prepare(
      "UPDATE prepaid_reservations SET state = 'released', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), reservationId);
  });
}

export function refundPrepaid(chargeId: string, entryId: string, amountUsd: string) {
  idSchema.parse(chargeId);
  idSchema.parse(entryId);
  const amount = parseUsdNanos(amountUsd);
  if (amount === 0) throw new PrepaidError("invalid_amount");
  const db = database();
  let apiKeyId: string;
  db.immediate(() => {
    const charge = entry(chargeId);
    if (!charge || charge.kind !== "charge") throw new PrepaidError("not_found");
    apiKeyId = charge.api_key_id;
    const previous = entry(entryId);
    if (previous) return matchesEntry(previous, apiKeyId, "refund", amount, chargeId);
    assertNotReservation(entryId);
    const refunds = db
      .prepare(
        "SELECT COALESCE(SUM(amount_nanos), 0) AS total FROM prepaid_entries WHERE kind = 'refund' AND reference_id = ?"
      )
      .get(chargeId) as { total: number };
    if (amount > charge.amount_nanos - refunds.total) throw new PrepaidError("conflict");
    const row = account(apiKeyId)!;
    if (!Number.isSafeInteger(row.balance_nanos + amount)) throw new PrepaidError("invalid_amount");
    db.prepare(
      "UPDATE prepaid_accounts SET balance_nanos = balance_nanos + ? WHERE api_key_id = ?"
    ).run(amount, apiKeyId);
    addEntry(entryId, apiKeyId, "refund", amount, chargeId);
  });
  return getPrepaidBalance(apiKeyId!)!;
}
