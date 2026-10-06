import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-issuance-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = randomUUID();
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/keys/route.ts");

test.before(async () => {
  process.env.INITIAL_PASSWORD = randomUUID();
  await settings.updateSettings({ requireLogin: true, cloudEnabled: false });
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function issue(id: string, body: Record<string, unknown> = { name: "tenant" }) {
  return route.POST(
    await makeManagementSessionRequest("http://localhost/api/keys", {
      method: "POST",
      headers: { "Idempotency-Key": id },
      body,
    })
  );
}

test("concurrent retries issue exactly one credential and survive reopening storage", async () => {
  const id = randomUUID();
  const before = keys.getApiKeysCount();
  const replies = await Promise.all(Array.from({ length: 8 }, () => issue(id)));
  const bodies = await Promise.all(replies.map((r) => r.json()));
  assert.equal(new Set(bodies.map((b) => b.id)).size, 1);
  assert.equal(new Set(bodies.map((b) => b.key)).size, 1);
  assert.equal(keys.getApiKeysCount(), before + 1);
  assert.equal(replies.filter((r) => r.status === 201).length, 1);
  core.resetDbInstance();
  const replay = await issue(id);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, bodies[0].id);
});

test("reusing an issuance ID with different policy conflicts without creating a key", async () => {
  const id = randomUUID();
  const first = await issue(id);
  assert.equal(first.status, 201);
  const before = keys.getApiKeysCount();
  const conflict = await issue(id, { name: "tenant", noLog: true });
  assert.equal(conflict.status, 409);
  const text = await conflict.text();
  assert.ok(!text.includes("at /") && !text.includes("sk-"));
  assert.equal(keys.getApiKeysCount(), before);
});

test("independent processes share the same durable issuance receipt", async () => {
  const id = randomUUID();
  const before = keys.getApiKeysCount();
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<{ id: string; replayed: boolean }>((resolve, reject) => {
          const child = fork(
            new URL("../fixtures/api-key-issuance-worker.ts", import.meta.url),
            [id],
            {
              execArgv: ["--import", "tsx/esm"],
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              timeout: 15000,
            }
          );
          let receipt: { id: string; replayed: boolean } | undefined;
          child.on("message", (message) => {
            receipt = message as typeof receipt;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0 && receipt) resolve(receipt);
            else reject(new Error(`Issuance worker failed: ${code}`));
          });
        })
    )
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(keys.getApiKeysCount(), before + 1);
});

test("replay reads current policy without resetting later permission changes", async () => {
  const id = randomUUID();
  const first = await (await issue(id)).json();
  await keys.updateApiKeyPermissions(first.id, { isActive: false, noLog: true });
  const replay = await (await issue(id)).json();
  assert.equal(replay.id, first.id);
  assert.equal(replay.isActive, false);
  assert.equal(replay.noLog, true);
});

test("same name is not ownership: distinct issuance IDs retain both keys", async () => {
  const a = await (await issue(randomUUID())).json();
  const b = await (await issue(randomUUID())).json();
  assert.notEqual(a.id, b.id);
  assert.ok(await keys.getApiKeyById(a.id));
  assert.ok(await keys.getApiKeyById(b.id));
});

test("model restrictions, activation and compression are applied before key publication", async () => {
  const result = await issue(randomUUID(), {
    name: "restricted",
    modelAccessMode: "restricted",
    allowedModels: ["example/model"],
    allowedCombos: [],
    compressionEnabled: false,
    isActive: false,
  });
  assert.equal(result.status, 201);
  const body = await result.json();
  const key = await keys.getApiKeyById(body.id);
  assert.equal(key?.modelAccessMode, "restricted");
  assert.deepEqual(key?.allowedModels, ["example/model"]);
  assert.deepEqual(key?.allowedCombos, []);
  assert.equal(key?.compressionEnabled, false);
  assert.equal(key?.isActive, false);
});

test("failed receipt write rolls back key and policy, and retry can complete", async () => {
  const db = core.getDbInstance();
  const id = randomUUID();
  const before = keys.getApiKeysCount();
  db.exec(`CREATE TEMP TRIGGER fail_issuance BEFORE INSERT ON api_key_issuances
    BEGIN SELECT RAISE(ABORT, 'synthetic issuance failure'); END`);
  try {
    const failed = await issue(id);
    assert.equal(failed.status, 500);
    assert.equal(keys.getApiKeysCount(), before);
  } finally {
    db.exec("DROP TRIGGER fail_issuance");
  }
  assert.equal((await issue(id)).status, 201);
  assert.equal(keys.getApiKeysCount(), before + 1);
});

test("deleted or rotated credentials cannot be resurrected by replay", async () => {
  for (const action of [keys.deleteApiKey, keys.regenerateApiKey]) {
    const id = randomUUID();
    const body = await (await issue(id)).json();
    await action(body.id);
    const before = keys.getApiKeysCount();
    assert.equal((await issue(id)).status, 409);
    assert.equal(keys.getApiKeysCount(), before);
  }
});

test("malformed and unauthenticated issuance requests create nothing", async () => {
  const before = keys.getApiKeysCount();
  assert.equal((await issue("not-a-uuid")).status, 400);
  const response = await route.POST(
    new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ name: "unauthorized" }),
    })
  );
  assert.equal(response.status, 401);
  assert.equal(keys.getApiKeysCount(), before);
});
