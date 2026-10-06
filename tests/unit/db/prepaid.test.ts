import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-prepaid-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = randomUUID();
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../src/lib/db/core.ts");
const keys = await import("../../../src/lib/db/apiKeys.ts");
const ledger = await import("../../../src/lib/db/prepaid.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function funded(amount: string) {
  const key = await keys.createApiKey("prepaid fixture", "fixture-machine");
  ledger.creditPrepaid(key.id, randomUUID(), amount);
  return key.id;
}

test("decimal input retains historical precision and rejects rounding, overflow and invalid amounts", () => {
  for (const [input, formatted] of [
    ["199.98854722", "199.988547220"],
    ["19.772321", "19.772321000"],
    ["0.000000001", "0.000000001"],
  ]) {
    assert.equal(ledger.formatUsdNanos(ledger.parseUsdNanos(input)), formatted);
  }
  for (const input of [
    "-1",
    "NaN",
    "Infinity",
    "1e-9",
    "0.0000000001",
    "9007199.254740992",
    "01",
    "1 ",
  ]) {
    assert.throws(() => ledger.parseUsdNanos(input), { code: "invalid_amount" });
  }
});

test("credit/import is durable and idempotent; changing its amount or account conflicts", async () => {
  const a = await funded("0.000000001");
  const b = await funded("1");
  const id = randomUUID();
  ledger.creditPrepaid(a, id, "199.98854722");
  assert.equal(core.getDbInstance().pragma("synchronous", { simple: true }), 2);
  core.resetDbInstance();
  assert.equal(ledger.creditPrepaid(a, id, "199.988547220").balanceUsd, "199.988547221");
  assert.throws(() => ledger.creditPrepaid(a, id, "200"), { code: "conflict" });
  assert.throws(() => ledger.creditPrepaid(b, id, "199.98854722"), { code: "conflict" });
});

test("independent processes cannot reserve more than the available balance", async () => {
  const account = await funded("1");
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<boolean>((resolve, reject) => {
          const child = fork(
            new URL("../../fixtures/prepaid-reservation-worker.ts", import.meta.url),
            [account, randomUUID(), "0.6"],
            {
              execArgv: ["--import", "tsx/esm"],
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              timeout: 15000,
            }
          );
          let admitted: boolean | undefined;
          child.on("message", (message) => {
            admitted = (message as { admitted: boolean }).admitted;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0 && admitted !== undefined) resolve(admitted);
            else reject(new Error(`Reservation worker failed: ${code}`));
          });
        })
    )
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(ledger.getPrepaidBalance(account)?.availableUsd, "0.400000000");
});

test("dispatch, settlement and bounded refunds cannot execute twice", async () => {
  const account = await funded("20");
  const requestId = randomUUID();
  ledger.reservePrepaid(account, requestId, "1");
  assert.equal(ledger.reservePrepaid(account, requestId, "1.0").replayed, true);
  ledger.dispatchPrepaid(requestId);
  assert.throws(() => ledger.dispatchPrepaid(requestId), { code: "conflict" });
  assert.throws(() => ledger.releasePrepaid(requestId), { code: "conflict" });
  assert.equal(ledger.settlePrepaid(requestId, "0.227679").balanceUsd, "19.772321000");
  assert.equal(ledger.settlePrepaid(requestId, "0.227679").availableUsd, "19.772321000");
  assert.throws(() => ledger.settlePrepaid(requestId, "0.3"), { code: "conflict" });
  const refund = randomUUID();
  assert.equal(ledger.refundPrepaid(requestId, refund, "0.1").balanceUsd, "19.872321000");
  assert.equal(ledger.refundPrepaid(requestId, refund, "0.1").balanceUsd, "19.872321000");
  assert.throws(() => ledger.refundPrepaid(requestId, randomUUID(), "0.2"), { code: "conflict" });
  assert.equal(
    ledger.refundPrepaid(requestId, randomUUID(), "0.127679").balanceUsd,
    "20.000000000"
  );
});

test("pre-dispatch failure releases the hold; unknown or over-bound provider outcomes preserve it across recovery", async () => {
  const account = await funded("3");
  const unused = randomUUID();
  ledger.reservePrepaid(account, unused, "1");
  ledger.releasePrepaid(unused);
  ledger.releasePrepaid(unused);
  assert.equal(ledger.getPrepaidBalance(account)?.reservedUsd, "0.000000000");
  const uncertain = randomUUID();
  ledger.reservePrepaid(account, uncertain, "2");
  ledger.dispatchPrepaid(uncertain);
  assert.throws(() => ledger.settlePrepaid(uncertain, "2.1"), { code: "insufficient_funds" });
  const backup = path.join(dataDir, "restore.sqlite");
  await core.getDbInstance().backup(backup);
  core.resetDbInstance();
  fs.copyFileSync(backup, path.join(dataDir, "storage.sqlite"));
  assert.equal(ledger.getPrepaidBalance(account)?.availableUsd, "1.000000000");
  assert.throws(() => ledger.releasePrepaid(uncertain), { code: "conflict" });
  assert.equal(ledger.settlePrepaid(uncertain, "1.25").availableUsd, "1.750000000");
});

test("failed journal write rolls back both account and reservation updates", async () => {
  const account = await funded("2");
  const request = randomUUID();
  ledger.reservePrepaid(account, request, "1");
  ledger.dispatchPrepaid(request);
  const db = core.getDbInstance();
  db.exec(`CREATE TEMP TRIGGER fail_prepaid BEFORE INSERT ON prepaid_entries
    BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END`);
  try {
    assert.throws(() => ledger.settlePrepaid(request, "0.5"), /synthetic journal failure/);
    assert.equal(ledger.getPrepaidBalance(account)?.balanceUsd, "2.000000000");
    assert.equal(ledger.getPrepaidBalance(account)?.reservedUsd, "1.000000000");
  } finally {
    db.exec("DROP TRIGGER fail_prepaid");
  }
  assert.equal(ledger.settlePrepaid(request, "0.5").balanceUsd, "1.500000000");
});

test("reservation replay cannot replace its pricing evidence", async () => {
  const id = await funded("1");
  const reservation = randomUUID();
  ledger.reservePrepaid(id, reservation, "0.5", { model: "fixture", price: 1 });
  assert.equal(
    ledger.reservePrepaid(id, reservation, "0.5", { price: 1, model: "fixture" }).replayed,
    true
  );
  assert.throws(
    () => ledger.reservePrepaid(id, reservation, "0.5", { model: "fixture", price: 2 }),
    { code: "conflict" }
  );
});

test("retirement persists durably and blocks new reservations without discarding money", async () => {
  for (const retire of [
    keys.deleteApiKey,
    keys.revokeApiKey,
    (id: string) => keys.updateApiKeyPermissions(id, { isActive: false }),
  ]) {
    const id = await funded("1");
    core.resetDbInstance();
    await retire(id);
    assert.equal(core.getDbInstance().pragma("synchronous", { simple: true }), 2);
    core.resetDbInstance();
    assert.throws(() => ledger.reservePrepaid(id, randomUUID(), "0.1"), { code: "conflict" });
    assert.equal(ledger.getPrepaidBalance(id)?.balanceUsd, "1.000000000");
  }
});

test("all materialized balances and holds reconcile to durable records", () => {
  const db = core.getDbInstance();
  const rows = db
    .prepare(
      `SELECT a.api_key_id FROM prepaid_accounts a WHERE
    a.balance_nanos != (SELECT SUM(CASE WHEN kind = 'charge' THEN -amount_nanos ELSE amount_nanos END)
      FROM prepaid_entries e WHERE e.api_key_id = a.api_key_id)
    OR a.reserved_nanos != (SELECT COALESCE(SUM(amount_nanos), 0) FROM prepaid_reservations r
      WHERE r.api_key_id = a.api_key_id AND r.state IN ('held', 'dispatched'))`
    )
    .all();
  assert.deepEqual(rows, []);
});

test("live restore cannot acknowledge a financial write against the database being replaced", async () => {
  const { restoreDbBackup } = await import("../../../src/lib/db/backup.ts");
  const account = await funded("1");
  const db = core.getDbInstance();
  const backupId = `db_${randomUUID()}_manual.sqlite`;
  fs.mkdirSync(core.DB_BACKUPS_DIR, { recursive: true });
  await db.backup(path.join(core.DB_BACKUPS_DIR, backupId));
  const restoring = restoreDbBackup(backupId);
  try {
    // Wait for the real native handle to close, leaving the restore's async replacement window.
    for (let attempt = 0; attempt < 100 && db.open; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(db.open, false);
    assert.throws(() => ledger.creditPrepaid(account, randomUUID(), "2"), { code: "unavailable" });
  } finally {
    await restoring;
  }
  assert.equal(ledger.getPrepaidBalance(account)?.balanceUsd, "1.000000000");
  core.resetDbInstance();
  assert.equal(ledger.getPrepaidBalance(account)?.balanceUsd, "1.000000000");
});

test("failed backup replacement recovers acknowledged credits and their idempotency receipts", async (t) => {
  const { replaceDbFromBackup } = await import("../../../src/lib/db/backup.ts");
  const account = await funded("1");
  const candidate = path.join(dataDir, "failure-candidate.sqlite");
  await core.getDbInstance().backup(candidate);
  const creditId = randomUUID();
  ledger.creditPrepaid(account, creditId, "2");
  const rename = fs.renameSync;
  let injected = false;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).startsWith(`${core.SQLITE_FILE}.restore-`) && to === core.SQLITE_FILE) {
      injected = true;
      throw Object.assign(new Error("synthetic install failure"), { code: "ENOSPC" });
    }
    return rename(from, to);
  });
  await assert.rejects(replaceDbFromBackup(candidate), /synthetic install failure/);
  assert.equal(injected, true);
  core.resetDbInstance();
  assert.equal(ledger.creditPrepaid(account, creditId, "2").balanceUsd, "3.000000000");
});

test("backup replacement retries a busy native file while keeping competing restores fenced", async (t) => {
  const { replaceDbFromBackup } = await import("../../../src/lib/db/backup.ts");
  const account = await funded("1");
  const candidate = path.join(dataDir, "busy-candidate.sqlite");
  await core.getDbInstance().backup(candidate);
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (from === core.SQLITE_FILE && ++attempts === 1)
      throw Object.assign(new Error("synthetic busy handle"), { code: "EBUSY" });
    return rename(from, to);
  });
  const restoring = replaceDbFromBackup(candidate);
  await assert.rejects(replaceDbFromBackup(candidate), /maintenance/i);
  await restoring;
  assert.equal(attempts, 2);
  assert.equal(ledger.getPrepaidBalance(account)?.balanceUsd, "1.000000000");
});

test("an interrupted restore marker prevents reopening or creating a financial database", async () => {
  const account = await funded("1");
  core.resetDbInstance();
  fs.writeFileSync(core.DB_RESTORE_MARKER, JSON.stringify({ interrupted: true }));
  try {
    assert.throws(() => core.getDbInstance(), /maintenance/i);
    assert.throws(() => ledger.creditPrepaid(account, randomUUID(), "2"), { code: "unavailable" });
  } finally {
    fs.unlinkSync(core.DB_RESTORE_MARKER);
  }
  assert.equal(ledger.getPrepaidBalance(account)?.balanceUsd, "1.000000000");
});
