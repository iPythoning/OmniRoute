import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-prepaid-inference-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = randomUUID();
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const ledger = await import("../../src/lib/db/prepaid.ts");
const settings = await import("../../src/lib/db/settings.ts");
const capabilities = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const pricing = await import("../../src/lib/db/settings/pricing.ts");
const meter = await import("../../src/lib/prepaid/inference.ts");
const route = await import("../../src/app/api/usage/prepaid/route.ts");
const keyRoute = await import("../../src/app/api/keys/route.ts");
const policy = await import("../../src/shared/utils/apiKeyPolicy.ts");
const sync = await import("../../src/lib/sync/bundle.ts");

test.before(async () => {
  await settings.updateSettings({ requireLogin: false, cloudEnabled: false });
  capabilities.setModelCapabilityOverride("openai/gpt-4o", "max_input_tokens", 1000);
  capabilities.setModelCapabilityOverride("openai/gpt-4o", "max_output_tokens", 1000);
  await pricing.updatePricing({
    openai: { "gpt-4o": { input: 1, output: 2, cached: 0.1, cache_creation: 1, reasoning: 2 } },
  });
});
test.after(async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  const { spendBatchWriter } = await import("../../src/lib/spend/batchWriter.ts");
  await spendBatchWriter.flush();
  const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
  await closeCallLogSaves();
  const { closeCallLogArtifactWriter } =
    await import("../../src/lib/usage/callLogArtifactWriter.ts");
  await closeCallLogArtifactWriter();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function funded(amount = "1") {
  const key = await keys.createApiKey("prepaid", "fixture-machine", [], { prepaidEnabled: true });
  ledger.creditPrepaid(key.id, randomUUID(), amount);
  return key;
}
function invoke(id: string, response: Response) {
  return meter.executePrepaidInference(id, "openai", { model: "gpt-4o", body: {} }, async () => ({
    response,
  }));
}
const payload = {
  choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
};
function sse(chunks: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

test("key publication includes a zero-balance account atomically and retry never resets credits", async () => {
  const id = randomUUID();
  const issue = () =>
    makeManagementSessionRequest("http://localhost/api/keys", {
      method: "POST",
      headers: { "Idempotency-Key": id },
      body: { name: "atomic", prepaidEnabled: true },
    }).then(keyRoute.POST);
  const first = await (await issue()).json();
  assert.equal(first.prepaidEnabled, true);
  assert.equal(ledger.getPrepaidBalance(first.id)?.balanceUsd, "0.000000000");
  ledger.creditPrepaid(first.id, randomUUID(), "19.772321");
  assert.equal((await (await issue()).json()).id, first.id);
  assert.equal(ledger.getPrepaidBalance(first.id)?.balanceUsd, "19.772321000");
});

test("management routes always require auth and ordinary inference keys cannot change money", async () => {
  const key = await funded();
  const body = { kind: "credit", apiKeyId: key.id, amountUsd: "5" };
  const request = (headers: HeadersInit = {}) =>
    new Request("http://localhost/api/usage/prepaid", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await route.POST(request())).status, 401);
  assert.equal((await route.POST(request({ Authorization: `Bearer ${key.key}` }))).status, 403);
  assert.equal(
    (await route.GET(new Request(`http://localhost/api/usage/prepaid?apiKeyId=${key.id}`))).status,
    401
  );
  const mint = await keyRoute.POST(
    new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unauthorized-admin", scopes: ["manage"] }),
    })
  );
  assert.equal(mint.status, 401, "local-mode bypass must not mint financial administrators");
  assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "1.000000000");
});

test("credit API validates precision, replays once, conflicts on changed request and exposes no key", async () => {
  const key = await funded();
  const id = randomUUID();
  const call = (amountUsd: unknown) =>
    makeManagementSessionRequest("http://localhost/api/usage/prepaid", {
      method: "POST",
      headers: { "Idempotency-Key": id },
      body: { kind: "credit", apiKeyId: key.id, amountUsd },
    }).then(route.POST);
  assert.equal((await call(2)).status, 400);
  assert.equal((await call("0.0000000001")).status, 400);
  assert.equal((await call("2")).status, 200);
  const replay = await call("2.0");
  assert.equal((await replay.json()).balanceUsd, "3.000000000");
  const conflict = await call("3");
  assert.equal(conflict.status, 409);
  const text = await conflict.text();
  assert.ok(!text.includes(key.key) && !text.includes("at /"));
});

test("non-streaming usage settles exactly once before completing and prices are snapshotted", async () => {
  const key = await funded();
  const result = await invoke(key.id, Response.json(payload));
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
  await pricing.updatePricing({ openai: { "gpt-4o": { input: 2, output: 4 } } });
  assert.deepEqual(await result.response.json(), payload);
  assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "0.999800000");
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
  await pricing.updatePricing({
    openai: { "gpt-4o": { input: 1, output: 2, cached: 0.1, cache_creation: 1, reasoning: 2 } },
  });
});

test("SSE chunk boundaries preserve bytes and settle before forwarding DONE", async () => {
  const key = await funded();
  const raw = `data: ${JSON.stringify(payload)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const chunks = Array.from(raw);
  const result = await invoke(key.id, sse(chunks));
  const reader = result.response.body!.getReader();
  let received = "";
  const decoder = new TextDecoder();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    received += decoder.decode(next.value, { stream: true });
    if (received.includes("[DONE]"))
      assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
  }
  assert.equal(received, raw);
  assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "0.999800000");
});

test("missing usage, truncated stream and client cancellation retain holds for reconciliation", async () => {
  for (const response of [
    Response.json({ choices: [] }),
    sse([`data: ${JSON.stringify(payload)}\n\n`]),
  ]) {
    const key = await funded();
    const result = await invoke(key.id, response);
    await assert.rejects(result.response.text());
    assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "1.000000000");
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
  }
  const key = await funded();
  const result = await invoke(key.id, sse(["data: {}\n\n"]));
  await result.response.body!.cancel();
  core.resetDbInstance();
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
});

test("HTTP rejection and transport errors retain reservations until evidenced reconciliation", async () => {
  const key = await funded();
  for (const status of [400, 408, 429, 503]) await invoke(key.id, new Response(null, { status }));
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.012000000");
  await assert.rejects(
    meter.executePrepaidInference(key.id, "openai", { model: "gpt-4o", body: {} }, async () => {
      throw new Error("synthetic network error");
    })
  );
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.015000000");
});

test("insufficient balance and absent prices prevent the upstream call", async () => {
  const key = await funded("0.001");
  let calls = 0;
  const execute = async () => {
    calls++;
    return { response: Response.json(payload) };
  };
  await assert.rejects(
    meter.executePrepaidInference(key.id, "openai", { model: "gpt-4o", body: {} }, execute),
    { status: 402 }
  );
  await assert.rejects(
    meter.executePrepaidInference(key.id, "unpriced", { model: "absent", body: {} }, execute),
    { status: 503 }
  );
  assert.equal(calls, 0);
});

test("prepaid keys cannot use an unmetered endpoint while standard keys keep existing access", async () => {
  const key = await funded();
  const request = new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.key}` },
  });
  assert.equal((await policy.enforceApiKeyPolicy(request, null)).rejection?.status, 403);
  const standard = await keys.createApiKey("standard", "fixture-machine");
  const unchanged = new Request(request.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${standard.key}` },
  });
  assert.equal((await policy.enforceApiKeyPolicy(unchanged, null)).rejection, null);
});

test("conflicting credentials cannot split authentication from prepaid metering", async () => {
  const key = await funded();
  const request = new Request("http://localhost/v1/search", {
    method: "POST",
    headers: { "x-api-key": key.key, "x-goog-api-key": randomUUID() },
  });
  assert.equal((await policy.enforceApiKeyPolicy(request, null)).rejection?.status, 400);
  const single = new Request(request.url, {
    method: "POST",
    headers: { "x-api-key": key.key },
  });
  assert.equal((await policy.enforceApiKeyPolicy(single, null)).apiKeyInfo?.id, key.id);
});

test("search authentication and prepaid billing retain one identity through the request pipeline", async (t) => {
  const { NextRequest } = await import("next/server");
  const { runAuthzPipeline } = await import("../../src/server/authz/pipeline.ts");
  const { AUTHZ_HEADER_AUTH_KIND } = await import("../../src/server/authz/headers.ts");
  const flags = await import("../../src/lib/db/featureFlags.ts");
  const providers = await import("../../src/lib/db/providers.ts");
  const { getSearchProvider } = await import("../../open-sse/config/searchRegistry.ts");
  const searchRoute = await import("../../src/app/api/v1/search/route.ts");
  const config = getSearchProvider("linkup-search")!;
  const price = ledger.formatUsdNanos(Math.round(config.costPerQuery * 1e9));
  const previousFlag = flags.getFeatureFlagOverride("REQUIRE_API_KEY");
  t.after(() => {
    if (previousFlag === undefined) flags.removeFeatureFlagOverride("REQUIRE_API_KEY");
    else flags.setFeatureFlagOverride("REQUIRE_API_KEY", previousFlag);
  });
  await providers.createProviderConnection({
    provider: config.id,
    authType: "apikey",
    name: "billing identity fixture",
    apiKey: randomUUID(),
    isActive: true,
    testStatus: "active",
  });
  const upstream = t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(new URL(String(input)).origin, new URL(config.baseUrl).origin);
    return Response.json({
      results: [{ name: "Fixture", url: "https://example.test/result", content: "Result" }],
    });
  });
  const request = (headers: HeadersInit) =>
    new NextRequest("http://localhost/api/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
      body: JSON.stringify({ query: randomUUID(), provider: config.id, max_results: 1 }),
    });
  const forwardedRequest = (original: Request, decision: Response) => {
    assert.equal(decision.headers.get("x-middleware-next"), "1");
    const headers = new Headers();
    for (const name of decision.headers.get("x-middleware-override-headers")!.split(",")) {
      const value = decision.headers.get(`x-middleware-request-${name}`);
      if (value !== null) headers.set(name, value);
    }
    return new Request(original, { headers });
  };
  const credential = (header: string, key: string) =>
    header === "authorization" ? `Bearer ${key}` : key;
  const headerNames = ["authorization", "x-api-key", "x-goog-api-key"];

  for (const requireKey of ["true", "false"]) {
    flags.setFeatureFlagOverride("REQUIRE_API_KEY", requireKey);
    await t.test(
      `conflicting headers are rejected before dispatch (require key=${requireKey})`,
      async () => {
        const key = await funded();
        const other = await funded();
        const before = upstream.mock.callCount();
        for (const primary of headerNames) {
          for (const secondary of headerNames.filter((header) => header !== primary)) {
            for (const conflictingKey of [randomUUID(), other.key]) {
              const headers = {
                [primary]: credential(primary, key.key),
                [secondary]: credential(secondary, conflictingKey),
              };
              const decision = await runAuthzPipeline(request(headers), { enforce: true });
              assert.equal(decision.status, 400);
              const response = await searchRoute.POST(request(headers));
              assert.equal(response.status, 400);
              const body = await response.text();
              assert.ok(!body.includes(key.key) && !body.includes(conflictingKey));
            }
          }
        }
        assert.equal(upstream.mock.callCount(), before);
        for (const id of [key.id, other.id]) {
          assert.equal(ledger.getPrepaidBalance(id)?.balanceUsd, "1.000000000");
          assert.equal(ledger.getPrepaidBalance(id)?.reservedUsd, "0.000000000");
          assert.equal(
            ledger.listPrepaidEntries(id, 10, 0).filter((entry) => entry.kind === "charge").length,
            0
          );
        }
      }
    );

    await t.test(
      `accepted headers charge only the authenticated key (require key=${requireKey})`,
      async () => {
        const other = await funded();
        for (const names of [...headerNames.map((name) => [name]), headerNames]) {
          const key = await funded();
          const before = upstream.mock.callCount();
          const original = request({
            ...Object.fromEntries(names.map((name) => [name, ` ${credential(name, key.key)} `])),
            [AUTHZ_HEADER_AUTH_KIND]: "anonymous",
          });
          const decision = await runAuthzPipeline(original, { enforce: true });
          const forwarded = forwardedRequest(original, decision);
          assert.equal(forwarded.headers.get(AUTHZ_HEADER_AUTH_KIND), "client_api_key");
          const response = await searchRoute.POST(forwarded);
          assert.equal(response.status, 200);
          assert.equal((await response.json()).cached, false);
          assert.equal(upstream.mock.callCount(), before + 1);
          assert.equal(
            ledger.getPrepaidBalance(key.id)?.balanceUsd,
            ledger.formatUsdNanos(ledger.parseUsdNanos("1") - ledger.parseUsdNanos(price))
          );
          assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
          const charges = ledger
            .listPrepaidEntries(key.id, 10, 0)
            .filter((entry) => entry.kind === "charge");
          assert.equal(charges.length, 1);
          assert.equal(charges[0].amountUsd, price);
          assert.equal(response.headers.get("x-omniroute-billing-id"), charges[0].id);
          assert.equal(ledger.getPrepaidBalance(other.id)?.balanceUsd, "1.000000000");
        }
      }
    );

    await t.test(
      `a key deleted after authentication cannot become an unbilled request (require key=${requireKey})`,
      async () => {
        const key = await funded();
        const original = request({ "x-api-key": key.key });
        const decision = await runAuthzPipeline(original, { enforce: true });
        const forwarded = forwardedRequest(original, decision);
        assert.equal(await keys.deleteApiKey(key.id), true);
        const before = upstream.mock.callCount();
        const response = await searchRoute.POST(forwarded);
        const balance = ledger.getPrepaidBalance(key.id);
        assert.deepEqual(
          {
            status: response.status,
            upstreamCalls: upstream.mock.callCount() - before,
            balanceUsd: balance?.balanceUsd,
            reservedUsd: balance?.reservedUsd,
          },
          { status: 401, upstreamCalls: 0, balanceUsd: "1.000000000", reservedUsd: "0.000000000" }
        );
      }
    );

    await t.test(
      `unknown-key handling respects the authentication mode (require key=${requireKey})`,
      async () => {
        const original = request({ "x-api-key": randomUUID() });
        const decision = await runAuthzPipeline(original, { enforce: true });
        const before = upstream.mock.callCount();
        if (requireKey === "true") {
          assert.equal(decision.status, 401);
          assert.equal((await searchRoute.POST(original)).status, 401);
          assert.equal(upstream.mock.callCount(), before);
        } else {
          const forwarded = forwardedRequest(original, decision);
          assert.equal(forwarded.headers.get(AUTHZ_HEADER_AUTH_KIND), "anonymous");
          assert.equal((await searchRoute.POST(forwarded)).status, 200);
          assert.equal(upstream.mock.callCount(), before + 1);
        }
      }
    );
  }
});

test("prepaid transport failures keep one dispatch and one unresolved hold", async () => {
  const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
  const { executePrepaidSearch } = await import("../../src/lib/prepaid/search.ts");
  for (const search of [false, true]) {
    const key = await funded();
    let dispatches = 0;
    const execute = async () => {
      const response = await proxyFetch(
        "https://billing.example.test/query",
        {
          method: "POST",
          body: "{}",
        },
        {
          undiciFetch: async () => {
            dispatches++;
            throw new TypeError("fetch failed");
          },
          nativeFetch: async () => {
            dispatches++;
            return Response.json(payload);
          },
        }
      );
      return { response, success: response.ok };
    };
    if (search) {
      await assert.rejects(
        executePrepaidSearch(key.id, { id: "fixture", costPerQuery: 0.01 }, execute)
      );
    } else {
      await assert.rejects(
        meter.executePrepaidInference(key.id, "openai", { model: "gpt-4o", body: {} }, execute)
      );
    }
    assert.equal(dispatches, 1);
    assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "1.000000000");
    assert.equal(ledger.listPrepaidReservations(key.id, 10, 0).length, 1);
  }
});

test("JSON and SSE retain cache creation costs and reject malformed billing dimensions", async () => {
  await pricing.updatePricing({
    openai: { "gpt-4o": { input: 1, output: 2, cached: 0.1, cache_creation: 5, reasoning: 3 } },
  });
  try {
    for (const stream of [false, true]) {
      const cached = { ...payload, usage: { ...payload.usage, cache_creation_input_tokens: 20 } };
      const key = await funded();
      const result = await invoke(
        key.id,
        stream
          ? sse([`data: ${JSON.stringify(cached)}\n\ndata: [DONE]\n\n`])
          : Response.json(cached)
      );
      await result.response.text();
      assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "0.999720000");
      for (const details of [
        { reasoning_tokens: "invalid" },
        { reasoning_tokens: 0.5 },
        { reasoning_tokens: -1 },
        { audio_tokens: 90 },
        { video_tokens: 90 },
      ]) {
        const badKey = await funded();
        const invalid = {
          ...payload,
          usage: { ...payload.usage, completion_tokens_details: details },
        };
        const bad = await invoke(
          badKey.id,
          stream
            ? sse([`data: ${JSON.stringify(invalid)}\n\ndata: [DONE]\n\n`])
            : Response.json(invalid)
        );
        await assert.rejects(bad.response.text());
        assert.equal(ledger.getPrepaidBalance(badKey.id)?.balanceUsd, "1.000000000");
        assert.notEqual(ledger.getPrepaidBalance(badKey.id)?.reservedUsd, "0.000000000");
      }
    }
  } finally {
    await pricing.updatePricing({
      openai: { "gpt-4o": { input: 1, output: 2, cached: 0.1, cache_creation: 1, reasoning: 2 } },
    });
  }
});

test("prepaid credentials stay on the authoritative ledger host and are excluded from config/cloud sync", async () => {
  const prepaid = await funded();
  const standard = await keys.createApiKey("sync-standard", "fixture-machine");
  const bundle = await sync.buildConfigSyncBundle();
  assert.ok(!bundle.apiKeys.some((key) => key.id === prepaid.id));
  assert.ok(bundle.apiKeys.some((key) => key.id === standard.id));
});

test("partial usage must not become a zero-token charge through extractor defaults", async () => {
  const key = await funded();
  const response = await invoke(key.id, Response.json({ usage: { prompt_tokens: 100 } }));
  await assert.rejects(response.response.text());
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
});

test("management can discover settled charge IDs and refund them exactly once", async () => {
  const key = await funded();
  const result = await invoke(key.id, Response.json(payload));
  await result.response.text();
  const request = await makeManagementSessionRequest(
    `http://localhost/api/usage/prepaid?apiKeyId=${key.id}&view=entries&limit=10`
  );
  const snapshot = await (await route.GET(request)).json();
  const charge = snapshot.entries.find((item: { kind: string }) => item.kind === "charge");
  assert.equal(charge.amountUsd, "0.000200000");
  const id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const refund = await route.POST(
      await makeManagementSessionRequest("http://localhost/api/usage/prepaid", {
        method: "POST",
        headers: { "Idempotency-Key": id },
        body: { kind: "refund", chargeId: charge.id, amountUsd: charge.amountUsd },
      })
    );
    assert.equal(refund.status, 200);
    assert.equal((await refund.json()).balanceUsd, "1.000000000");
  }
});

test("unresolved holds are visible and evidence-backed reconciliation is idempotent", async () => {
  const key = await funded();
  await assert.rejects(
    meter.executePrepaidInference(key.id, "openai", { model: "gpt-4o", body: {} }, async () => {
      throw new Error("synthetic timeout");
    })
  );
  const request = await makeManagementSessionRequest(
    `http://localhost/api/usage/prepaid?apiKeyId=${key.id}&limit=10`
  );
  const snapshot = await (await route.GET(request)).json();
  assert.equal(snapshot.reservations.length, 1);
  const id = snapshot.reservations[0].id;
  assert.equal(snapshot.reservations[0].billingContext.pricing.input, 1);
  const reconcile = (evidence: string) =>
    makeManagementSessionRequest("http://localhost/api/usage/prepaid", {
      method: "POST",
      headers: { "Idempotency-Key": id },
      body: { kind: "reconcile", reservationId: id, amountUsd: "0", evidence },
    }).then(route.POST);
  assert.equal((await reconcile("")).status, 400);
  assert.equal(
    (await reconcile("fixture: verified provider rejected before generation")).status,
    200
  );
  assert.equal(
    (await reconcile("fixture: verified provider rejected before generation")).status,
    200
  );
  assert.equal((await reconcile("different evidence")).status, 409);
  assert.equal(ledger.getPrepaidBalance(key.id)?.availableUsd, "1.000000000");
});

test("real chatCore JSON and SSE paths commit the prepaid ledger through the executor boundary", async () => {
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
  const { withEarlyStreamKeepalive } = await import("../../open-sse/utils/earlyStreamKeepalive.ts");
  const originalFetch = globalThis.fetch;
  await settings.updateSettings({ memoryEnabled: true, skillsEnabled: true, memoryMaxTokens: 0 });
  try {
    for (const mode of ["json", "sse", "delayed-sse"]) {
      const stream = mode !== "json";
      const key = await funded();
      let providerCalls = 0;
      globalThis.fetch = async (_url, init) => {
        providerCalls++;
        const sent = JSON.parse(String(init?.body));
        assert.ok(!sent.tools?.length, "prepaid chat must not inject unmetered server tools");
        return stream
          ? sse([
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }] })}\n\n`,
              `data: ${JSON.stringify({ id: "fixture", choices: [], usage: payload.usage })}\n\ndata: [DONE]\n\n`,
            ])
          : Response.json({
              id: "fixture",
              object: "chat.completion",
              model: "gpt-4o",
              ...payload,
            });
      };
      const body = {
        model: "openai/gpt-4o",
        stream,
        messages: [{ role: "user", content: randomUUID() }],
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "openai", model: "gpt-4o", extendedContext: false },
        credentials: { apiKey: randomUUID(), providerSpecificData: {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
        },
        apiKeyInfo: { id: key.id, compressionEnabled: false },
        userAgent: "prepaid-test",
        onCredentialsRefreshed: undefined,
        onRequestSuccess: undefined,
        onStreamFailure: undefined,
        onDisconnect: undefined,
        connectionId: undefined,
        comboName: undefined,
      });
      assert.ok(!(result instanceof Response));
      assert.equal(result.response.status, 200);
      let response = result.response;
      if (mode === "delayed-sse") {
        let release!: (response: Response) => void;
        const deferred = new Promise<Response>((resolve) => {
          release = resolve;
        });
        response = await withEarlyStreamKeepalive(deferred, { thresholdMs: 0 });
        release(result.response);
      }
      const text = await response.text();
      assert.match(text, /answer/);
      assert.equal(providerCalls, 1);
      assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "0.999800000");
      assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
      const billingId = result.response.headers.get("x-omniroute-billing-id");
      assert.ok(billingId, "final responses expose the settled attempt ID");
      assert.equal(
        ledger.listPrepaidEntries(key.id, 10, 0).find((entry) => entry.kind === "charge")?.id,
        billingId
      );
      if (mode === "delayed-sse")
        assert.ok(text.includes(`: X-OmniRoute-Billing-Id: ${billingId}\n\n`));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await settings.updateSettings({ memoryEnabled: false, skillsEnabled: false });
  }
});

test("prepaid native tools and extra billing dimensions are rejected before fallback conversion", async () => {
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
  const key = await funded();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return Response.json(payload);
    };
    for (const option of [
      { tools: [{ type: "web_search_20250305", name: "web_search" }] },
      { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] },
      { tools: [{ type: "image_generation" }] },
      { tools: [{ googleSearch: {} }] },
      { tools: [{ type: "function", function: { name: "lookup" }, googleSearch: {} }] },
      { tools: [{ codeExecution: {} }] },
      { generationConfig: { candidateCount: 2 } },
      { web_search_options: {} },
      { modalities: ["text", "audio"] },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }],
          },
        ],
      },
      {
        input: [
          {
            role: "user",
            content: [{ type: "audio_url", audio_url: "https://example.test/clip.wav" }],
          },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "input_video", video_url: "https://example.test/clip.mp4" }],
          },
        ],
      },
      {
        contents: [
          { role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }] },
        ],
      },
      {
        contents: [
          {
            role: "user",
            parts: [
              { file_data: { mime_type: "video/mp4", file_uri: "https://example.test/clip.mp4" } },
            ],
          },
        ],
      },
      { best_of: 2 },
    ]) {
      const body = {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: randomUUID() }],
        ...option,
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "openai", model: "gpt-4o", extendedContext: false },
        credentials: { apiKey: randomUUID(), providerSpecificData: {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: new Headers() },
        apiKeyInfo: { id: key.id, compressionEnabled: false },
        userAgent: "prepaid-test",
        onCredentialsRefreshed: undefined,
        onRequestSuccess: undefined,
        onStreamFailure: undefined,
        onDisconnect: undefined,
        connectionId: undefined,
        comboName: undefined,
      });
      assert.ok(!(result instanceof Response));
      assert.equal(result.response.status, 400);
    }
    assert.equal(calls, 0);
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepaid requests reject input audio before an enabled bridge can dispatch under an internal key", async () => {
  const { handleChat } = await import("../../src/sse/handlers/chat.ts");
  const { guardrailRegistry } = await import("../../src/lib/guardrails/registry.ts");
  const { AudioBridgeGuardrail } = await import("../../src/lib/guardrails/audioBridge.ts");
  const key = await funded("0.000000001");
  const previous = guardrailRegistry.list();
  let childCalls = 0;
  guardrailRegistry.register(
    new AudioBridgeGuardrail({
      enabled: true,
      deps: {
        getSettings: async () => ({ audioBridgeEnabled: true }),
        getCapabilities: () => ({ supportsAudio: false }),
        selectModel: async () => "fixture/transcription",
        callTranscription: async () => {
          childCalls++;
          return "transcribed";
        },
      },
    })
  );
  try {
    const response = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
        body: JSON.stringify({
          model: "openai/gpt-4o",
          messages: [
            {
              role: "user",
              content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }],
            },
          ],
        }),
      })
    );
    assert.equal(childCalls, 0);
    assert.equal(response.status, 400);
    assert.equal(ledger.getPrepaidBalance(key.id)?.availableUsd, "0.000000001");
  } finally {
    guardrailRegistry.clear();
    previous.forEach((guardrail) => guardrailRegistry.register(guardrail));
  }
});

test("prepaid MCP search completes SDK setup and dispatches exactly one billable tool call", async () => {
  const { handleSearch } = await import("../../open-sse/handlers/search.ts");
  const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
  const originalFetch = globalThis.fetch;
  const key = await funded();
  const methods: string[] = [];
  const upstream: typeof fetch = async (_url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    methods.push(body.method ?? init.method ?? "GET");
    if (body.method === "initialize")
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        },
        { headers: { "mcp-session-id": "prepaid-fixture" } }
      );
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call")
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { title: "fixture", link: "https://example.test", content: "answer" },
              ]),
            },
          ],
        },
      });
    return new Response(null, { status: 405 });
  };
  globalThis.fetch = (url, init) =>
    proxyFetch(url, init, { nativeFetch: upstream, undiciFetch: upstream });
  try {
    const result = await handleSearch({
      query: "prepaid SDK fixture",
      provider: "zai-search",
      maxResults: 1,
      searchType: "web",
      credentials: { apiKey: randomUUID() },
      apiKeyId: key.id,
    });
    assert.equal(result.success, true, result.error);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("notifications/initialized"));
    assert.equal(methods.filter((method) => method === "tools/call").length, 1);
    assert.equal(
      ledger.listPrepaidEntries(key.id, 10, 0).filter((entry) => entry.kind === "charge").length,
      1
    );
    assert.equal(ledger.listPrepaidReservations(key.id, 10, 0).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP setup exemption cannot replay a tool call or disable the parent dispatch fence", async () => {
  const { proxyFetch, runWithSingleDispatch } = await import("../../open-sse/utils/proxyFetch.ts");
  for (const fail of [false, true]) {
    let calls = 0;
    const upstream: typeof fetch = async () => {
      calls++;
      if (fail) throw new Error("synthetic network failure");
      return Response.json({});
    };
    const request = (method: string) =>
      proxyFetch(
        "https://example.test/mcp",
        {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", method, id: 1 }),
        },
        { undiciFetch: upstream, nativeFetch: upstream }
      );
    await runWithSingleDispatch(
      async () => {
        if (fail) await assert.rejects(request("tools/call"), /synthetic network failure/);
        else await request("tools/call");
        await assert.rejects(request("tools/call"), /cannot be replayed/);
      },
      { protocol: "mcp" }
    );
    assert.equal(calls, 1);
    await runWithSingleDispatch(async () => {
      if (fail) await assert.rejects(request("initialize"));
      else await request("initialize");
      await assert.rejects(
        runWithSingleDispatch(() => request("notifications/initialized"), { protocol: "mcp" }),
        /cannot be replayed/
      );
    });
    assert.equal(calls, 2);
  }
});

test("Responses and Claude SSE usage follows terminal snapshots without losing cached input", async () => {
  for (const events of [
    [
      { type: "response.output_text.delta", delta: "answer" },
      { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 50 } } },
    ],
    [
      {
        type: "message_start",
        message: { usage: { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 1 } },
      },
      { type: "message_delta", usage: { output_tokens: 50 } },
      { type: "message_stop" },
    ],
  ]) {
    const key = await funded();
    const result = await invoke(
      key.id,
      sse(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    );
    await result.response.text();
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
    const expected = events[0].type === "message_start" ? "0.999827000" : "0.999800000";
    assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, expected);
  }
});

test("proxy fallback reserves each attempt and keeps ambiguous primary holds", async () => {
  const { resolveExecutorWithProxy } =
    await import("../../open-sse/handlers/chatCore/executorProxy.ts");
  const upstream = await import("../../src/lib/db/upstreamProxy.ts");
  const { clearUpstreamProxyConfigCache } =
    await import("../../open-sse/handlers/chatCore/comboContextCache.ts");
  const key = await funded();
  await upstream.upsertUpstreamProxyConfig({
    providerId: "openai",
    enabled: true,
    mode: "fallback",
  });
  clearUpstreamProxyConfigCache("openai");
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) throw new Error("synthetic primary network ambiguity");
      return Response.json(payload);
    };
    const executor = await resolveExecutorWithProxy("openai", undefined, undefined, (original) =>
      meter.wrapPrepaidExecutor(original, key.id, "openai")
    );
    const result = await executor.execute({
      model: "gpt-4o",
      body: {},
      stream: false,
      credentials: { apiKey: randomUUID() },
    });
    assert.equal(attempts, 2);
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.006000000");
    await result.response.text();
    assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "0.999800000");
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
  } finally {
    globalThis.fetch = originalFetch;
    await upstream.upsertUpstreamProxyConfig({
      providerId: "openai",
      enabled: false,
      mode: "native",
    });
    clearUpstreamProxyConfigCache("openai");
  }
});

test("non-streaming settlement failure withholds JSON and preserves the hold", async () => {
  const key = await funded();
  const result = await invoke(key.id, Response.json(payload));
  const db = core.getDbInstance();
  db.exec(
    "CREATE TRIGGER prepaid_fail_charge BEFORE INSERT ON prepaid_entries WHEN NEW.kind = 'charge' BEGIN SELECT RAISE(ABORT, 'fixture'); END"
  );
  try {
    await assert.rejects(result.response.body!.getReader().read());
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
    assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "1.000000000");
  } finally {
    db.exec("DROP TRIGGER prepaid_fail_charge");
  }
});

test("Claude stop_reason stays withheld when durable settlement fails", async () => {
  const key = await funded();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
    { type: "message_stop" },
  ];
  const result = await invoke(
    key.id,
    sse(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
  );
  const db = core.getDbInstance();
  db.exec(
    "CREATE TRIGGER prepaid_fail_charge BEFORE INSERT ON prepaid_entries WHEN NEW.kind = 'charge' BEGIN SELECT RAISE(ABORT, 'fixture'); END"
  );
  let received = "";
  try {
    const reader = result.response.body!.getReader();
    await assert.rejects(async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        received += new TextDecoder().decode(next.value);
      }
    });
    assert.match(received, /answer/);
    assert.doesNotMatch(received, /end_turn|message_stop/);
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
    assert.equal(ledger.getPrepaidBalance(key.id)?.balanceUsd, "1.000000000");
  } finally {
    db.exec("DROP TRIGGER prepaid_fail_charge");
  }
});

test("prepaid base dispatch does not hide a reactive 400 retry", async () => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return Response.json(
        { error: { message: "Unsupported parameter: temperature" } },
        { status: 400 }
      );
    };
    const key = await funded();
    const executor = meter.wrapPrepaidExecutor(await getExecutor("openai"), key.id, "openai");
    const result = await executor.execute({
      model: "gpt-4o",
      body: { temperature: 0.5 },
      stream: false,
      credentials: { apiKey: randomUUID() },
    });
    assert.ok(!(result instanceof Response));
    assert.equal(result.response.status, 400);
    assert.equal(calls, 1);
    assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.003000000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unaudited custom execution fails before dispatch or reservation", async () => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const key = await funded();
  const custom = Object.create(await getExecutor("openai"));
  let calls = 0;
  custom.execute = async () => {
    calls++;
    return { response: Response.json(payload) };
  };
  await assert.rejects(
    meter
      .wrapPrepaidExecutor(custom, key.id, "openai")
      .execute({ model: "gpt-4o", body: {}, stream: false, credentials: {} }),
    { status: 503 }
  );
  assert.equal(calls, 0);
  assert.equal(ledger.getPrepaidBalance(key.id)?.reservedUsd, "0.000000000");
});

test("search primary and fallback are independently metered; insufficient funds never fetch", async () => {
  const { handleSearch } = await import("../../open-sse/handlers/search.ts");
  const { getSearchProvider } = await import("../../open-sse/config/searchRegistry.ts");
  const primary = getSearchProvider("brave-search")!;
  const secondary = getSearchProvider("serper-search")!;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const run = (id: string) =>
    handleSearch({
      query: "fixture",
      provider: primary.id,
      maxResults: 1,
      searchType: "web",
      credentials: { apiKey: randomUUID() },
      apiKeyId: id,
      alternateProvider: secondary.id,
      alternateCredentials: { apiKey: randomUUID() },
    });
  try {
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return Response.json({
        organic: [{ title: "fixture", link: "https://example.com", snippet: "fixture" }],
      });
    };
    const key = await funded();
    const result = await run(key.id);
    assert.equal(result.success, true);
    assert.equal(calls, 2);
    assert.equal(
      ledger.getPrepaidBalance(key.id)?.reservedUsd,
      ledger.formatUsdNanos(Math.round(primary.costPerQuery * 1e9))
    );
    assert.equal(
      ledger.getPrepaidBalance(key.id)?.balanceUsd,
      ledger.formatUsdNanos(1e9 - Math.round(secondary.costPerQuery * 1e9))
    );
    const empty = await keys.createApiKey("empty-search", "fixture-machine", [], {
      prepaidEnabled: true,
    });
    assert.equal((await run(empty.id)).status, 402);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
