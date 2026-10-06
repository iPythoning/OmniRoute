import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBunSqliteAdapter,
  type BunSqliteDatabaseLike,
} from "../../../src/lib/db/adapters/bunSqliteAdapter.ts";

test("bun:sqlite adapter supports CRUD, pragmas, transactions, and close", async (t) => {
  if (!process.versions.bun) {
    t.skip("bun:sqlite is only available under Bun");
    return;
  }

  const { Database } = await import("bun:sqlite");
  const adapter = createBunSqliteAdapter(new Database(":memory:"), ":memory:");
  t.after(() => adapter.close());

  adapter.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  const result = adapter.prepare("INSERT INTO items (name) VALUES (?)").run("bun");
  assert.equal(result.changes, 1);
  assert.equal((adapter.prepare("SELECT name FROM items").get() as { name: string }).name, "bun");
  assert.equal(adapter.driver, "bun:sqlite");
  assert.equal(adapter.pragma("user_version", { simple: true }), 0);

  adapter.prepare("INSERT INTO items (name) VALUES (@name)").run({ name: "named" });
  assert.equal(
    (
      adapter.prepare("SELECT name FROM items WHERE name = :name").get({ name: "named" }) as {
        name: string;
      }
    ).name,
    "named"
  );

  adapter.transaction(() => {
    adapter.prepare("INSERT INTO items (name) VALUES (?)").run("transaction");
  })();
  assert.equal(adapter.prepare("SELECT COUNT(*) AS count FROM items").get().count, 3);
  assert.equal(adapter.open, true);
  adapter.close();
  assert.equal(adapter.open, false);
});

test("bun:sqlite adapter backs up on-disk databases without serializing them", async (t) => {
  const DatabaseSync = process.versions.bun
    ? (await import("bun:sqlite")).Database
    : (await import("node:sqlite")).DatabaseSync;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wal-backup-"));
  const sourcePath = path.join(dir, "source.sqlite");
  const destinationPath = path.join(dir, "backup.sqlite");
  const db = new DatabaseSync(sourcePath);
  const reader = new DatabaseSync(sourcePath);
  t.after(() => {
    reader.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1; CREATE TABLE reservation(state TEXT); INSERT INTO reservation VALUES ('held'); PRAGMA wal_checkpoint(TRUNCATE)"
  );
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM reservation").get();
  db.exec("UPDATE reservation SET state = 'dispatched'");
  assert.equal(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 1);
  const adapter = createBunSqliteAdapter(
    {
      query: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => {},
      transaction: () => {
        throw new Error("unused");
      },
      serialize: () => {
        throw new Error("must not serialize whole DB into memory");
      },
    } as BunSqliteDatabaseLike,
    sourcePath
  );
  await adapter.backup(destinationPath);
  const restored = new DatabaseSync(destinationPath);
  try {
    assert.equal(restored.prepare("SELECT state FROM reservation").get()?.state, "dispatched");
  } finally {
    restored.close();
    reader.exec("ROLLBACK");
  }
});

test("loadSqliteRuntime prioritizes bun:sqlite under Bun without loading better-sqlite3", async (t) => {
  if (!process.versions.bun) {
    t.skip("bun:sqlite is only available under Bun");
    return;
  }

  const { loadSqliteRuntime } = await import("../../../bin/cli/runtime/sqliteRuntime.mjs");
  const runtime = await loadSqliteRuntime();
  assert.equal(runtime.driver.kind, "bun-sqlite");
  assert.equal(runtime.source, "bun-sqlite");
});
