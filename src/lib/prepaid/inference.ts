import { randomUUID } from "node:crypto";
import {
  dispatchPrepaid,
  formatUsdNanos,
  getPrepaidBalance,
  reservePrepaid,
  settlePrepaid,
  PrepaidError,
} from "@/lib/db/prepaid";
import { getPricingForModel } from "@/lib/db/settings/pricing";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import { computeCostFromPricing } from "@/lib/usage/costCalculator";
import { extractUsageFromResponse } from "@omniroute/open-sse/handlers/usageExtractor";
import { extractUsage } from "@omniroute/open-sse/utils/usageTracking";
import {
  createSSEDataLineNormalizer,
  parseSSEDataPayload,
} from "@omniroute/open-sse/utils/streamHelpers";
import { MAX_BODY_BYTES } from "@/shared/middleware/bodySizeGuard";
import { BaseExecutor } from "@omniroute/open-sse/executors/base";
import { DefaultExecutor } from "@omniroute/open-sse/executors/default";
import { CliproxyapiExecutor } from "@omniroute/open-sse/executors/cliproxyapi";
import { DarioExecutor } from "@omniroute/open-sse/executors/dario";
import { normalizeExecutorResult } from "@omniroute/open-sse/handlers/chatCore/upstreamTimeouts";
import { runWithSingleDispatch } from "@omniroute/open-sse/utils/proxyFetch";

type Usage = Record<string, number | undefined>;
type BillingQuote = {
  provider: string;
  model: string;
  pricing: Record<string, unknown>;
  serviceTier?: string;
  maximumUsd: string;
};

export class PrepaidInferenceError extends Error {
  readonly status: number;
  readonly code = "prepaid_unavailable";
  constructor(status = 503) {
    super(
      status === 402
        ? "Insufficient prepaid balance"
        : status === 400
          ? "Request contains unsupported prepaid billing options"
          : "Prepaid billing is temporarily unavailable"
    );
    this.status = status;
  }
}

export function assertPrepaidChatBody(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PrepaidInferenceError(400);
  const body = value as Record<string, unknown>;
  const generationConfig = body.generationConfig as Record<string, unknown> | undefined;
  // Only client-executed function declarations have token-only billing.
  const toolFields = new Set([
    "type",
    "function",
    "name",
    "description",
    "parameters",
    "strict",
    "input_schema",
    "cache_control",
    "functionDeclarations",
    "function_declarations",
  ]);
  if (
    (body.n !== undefined && body.n !== 1) ||
    (body.best_of !== undefined && body.best_of !== 1) ||
    body.web_search_options !== undefined ||
    body.audio !== undefined ||
    (generationConfig?.candidateCount !== undefined && generationConfig.candidateCount !== 1) ||
    generationConfig?.speechConfig !== undefined ||
    (generationConfig?.responseModalities !== undefined &&
      (!Array.isArray(generationConfig.responseModalities) ||
        generationConfig.responseModalities.some((mode) => mode !== "TEXT"))) ||
    (body.modalities !== undefined &&
      (!Array.isArray(body.modalities) || body.modalities.some((mode) => mode !== "text"))) ||
    (body.tools !== undefined &&
      (!Array.isArray(body.tools) ||
        body.tools.some(
          (tool) =>
            !tool ||
            typeof tool !== "object" ||
            Object.keys(tool).some((field) => !toolFields.has(field)) ||
            (tool.type !== undefined && tool.type !== "function")
        )))
  )
    throw new PrepaidInferenceError(400);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function usagePresence(payload: Record<string, unknown>): { input: boolean; output: boolean } {
  const asRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const response = asRecord(payload.response);
  const raw = asRecord(payload.usage ?? response.usage ?? asRecord(payload.message).usage);
  const meta = asRecord(payload.usageMetadata ?? response.usageMetadata);
  const input = raw.prompt_tokens ?? raw.input_tokens ?? meta.promptTokenCount;
  const output = raw.completion_tokens ?? raw.output_tokens ?? meta.candidatesTokenCount;
  const valid = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  return { input: valid(input), output: valid(output) };
}

function validateRawUsage(payload: Record<string, unknown>): void {
  const visit = (value: unknown) => {
    if (value == null) return;
    if (typeof value !== "object" || Array.isArray(value)) throw new PrepaidInferenceError();
    for (const [field, count] of Object.entries(value)) {
      if (
        field.endsWith("_tokens") ||
        field.endsWith("TokenCount") ||
        field === "cost_in_usd_ticks"
      ) {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
          throw new PrepaidInferenceError();
      } else if (field.endsWith("_tokens_details")) visit(count);
    }
  };
  for (const container of [payload, payload.response, payload.message]) {
    if (!container || typeof container !== "object") continue;
    const record = container as Record<string, unknown>;
    visit(record.usage);
    visit(record.usageMetadata);
  }
}

async function quote(provider: string, model: string, serviceTier?: string): Promise<BillingQuote> {
  const pricing = await getPricingForModel(provider, model);
  if (!pricing) throw new PrepaidInferenceError();
  const rates = [
    pricing.input,
    pricing.output,
    pricing.cached,
    pricing.cache_creation,
    pricing.reasoning,
  ];
  if (
    pricing.input == null ||
    pricing.output == null ||
    rates.some(
      (value) =>
        value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    )
  )
    throw new PrepaidInferenceError();
  const capabilities = getResolvedModelCapabilities({ provider, model });
  const inputCap = capabilities.maxInputTokens ?? capabilities.contextWindow;
  const outputCap = capabilities.maxOutputTokens;
  if (!positiveInteger(inputCap) || !positiveInteger(outputCap)) throw new PrepaidInferenceError();
  // Reserve the model's full configured input/output capacity. An estimate is not a hard spending bound.
  const maxInput = Math.max(
    ...[pricing.input, pricing.cached, pricing.cache_creation].filter(
      (v): v is number => typeof v === "number"
    )
  );
  const maxOutput = Math.max(
    ...[pricing.output, pricing.reasoning].filter((v): v is number => typeof v === "number")
  );
  const maximum = computeCostFromPricing(
    { input: maxInput, output: maxOutput },
    {
      prompt_tokens: inputCap,
      completion_tokens: outputCap,
    },
    { provider, model, serviceTier }
  );
  const nanos = Math.ceil(maximum * 1e9);
  if (!Number.isSafeInteger(nanos) || nanos < 0) throw new PrepaidInferenceError();
  return {
    provider,
    model,
    pricing: { ...pricing },
    serviceTier,
    maximumUsd: formatUsdNanos(nanos),
  };
}

function settle(id: string, billing: BillingQuote, usage: Usage | null): void {
  if (
    !usage ||
    !Number.isSafeInteger(usage.prompt_tokens) ||
    !Number.isSafeInteger(usage.completion_tokens) ||
    Object.values(usage).some(
      (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)
    )
  )
    throw new PrepaidInferenceError();
  if (
    (usage.cached_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) > usage.prompt_tokens! ||
    (usage.reasoning_tokens ?? 0) > usage.completion_tokens!
  )
    throw new PrepaidInferenceError();
  const cost = computeCostFromPricing(billing.pricing, usage, billing);
  const nanos = Math.round(cost * 1e9);
  if (!Number.isSafeInteger(nanos) || nanos < 0) throw new PrepaidInferenceError();
  settlePrepaid(id, formatUsdNanos(nanos));
}

// Observe raw provider usage before translation/sanitization can synthesize estimated usage.
function meterResponse(response: Response, id: string, billing: BillingQuote): Response {
  if (!response.body) throw new PrepaidInferenceError();
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") === true;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const normalizer = createSSEDataLineNormalizer();
  let pending = "";
  let usage: Usage | null = null;
  let inputPresent = false;
  let outputPresent = false;
  let eventType = "";
  let complete = false;
  let terminalSeen = false;
  let invalid = false;
  let pendingEventSize = 0;
  let wireEvent = "";
  const maximumBuffered = MAX_BODY_BYTES;
  const tail: Uint8Array[] = [];
  let tailSize = 0;
  const observe = (lines: string[]) => {
    for (const line of normalizer.normalize(lines)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (!line) eventType = "";
      if (!line.startsWith("data:")) continue;
      const payload = parseSSEDataPayload(line.slice(5), { eventType, logWarning: false });
      if (!payload) {
        invalid = true;
        continue;
      }
      if (
        payload.error ||
        payload.type === "error" ||
        payload.type === "response.failed" ||
        payload.type === "response.incomplete"
      )
        invalid = true;
      if (
        payload.done ||
        payload.type === "message_stop" ||
        payload.type === "response.completed" ||
        payload.type === "response.done" ||
        (Array.isArray(payload.candidates) &&
          payload.candidates.some((c: { finishReason?: string }) => Boolean(c.finishReason)))
      )
        complete = true;
      if (
        complete ||
        (payload.type === "message_delta" &&
          payload.delta &&
          typeof payload.delta === "object" &&
          "stop_reason" in payload.delta &&
          payload.delta.stop_reason != null) ||
        (Array.isArray(payload.choices) &&
          payload.choices.some(
            (choice: { finish_reason?: unknown }) => choice.finish_reason != null
          ))
      )
        terminalSeen = true;
      validateRawUsage(payload);
      const extracted = extractUsage(payload);
      if (extracted) {
        const present = usagePresence(payload);
        // Claude reports input at message_start and output at message_delta; neither is additive.
        if (payload.type === "message_delta" && usage) {
          usage = {
            ...usage,
            completion_tokens: extracted.completion_tokens,
            reasoning_tokens: extracted.reasoning_tokens,
          };
          outputPresent = present.output;
        } else {
          usage = extracted;
          inputPresent = present.input;
          outputPresent = present.output && payload.type !== "message_start";
        }
      }
    }
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > maximumBuffered) throw new PrepaidInferenceError();
        if (isSse) {
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            pendingEventSize += line.length;
            if (pendingEventSize > maximumBuffered) throw new PrepaidInferenceError();
            wireEvent += `${line}\n`;
            observe([line]);
            if (!normalizer.hasPending()) {
              pendingEventSize = 0;
              const frame = encoder.encode(wireEvent);
              wireEvent = "";
              if (terminalSeen) {
                tailSize += frame.byteLength;
                if (tailSize > maximumBuffered) throw new PrepaidInferenceError();
                tail.push(frame);
              } else controller.enqueue(frame);
            }
          }
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (isSse) {
          observe([pending, ""]);
          if (invalid || !complete) throw new PrepaidInferenceError();
          if (wireEvent || pending) tail.push(encoder.encode(wireEvent + pending));
        } else {
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(pending);
          } catch {
            throw new PrepaidInferenceError();
          }
          if (payload.error) throw new PrepaidInferenceError();
          validateRawUsage(payload);
          usage = extractUsageFromResponse(payload, billing.provider);
          const present = usagePresence(payload);
          inputPresent = present.input;
          outputPresent = present.output;
        }
        if (!inputPresent || !outputPresent) throw new PrepaidInferenceError();
        // Synchronous durable commit before the response body can finish successfully.
        try {
          settle(id, billing, usage);
        } catch {
          throw new PrepaidInferenceError();
        }
        if (!isSse) controller.enqueue(encoder.encode(pending));
        for (const chunk of tail) controller.enqueue(chunk);
      },
    })
  );
  const headers = new Headers(response.headers);
  headers.set("x-omniroute-billing-id", id);
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function wrapPrepaidExecutor<T extends BaseExecutor>(
  executor: T,
  apiKeyId: string | null | undefined,
  provider: string
): T {
  if (!apiKeyId || !getPrepaidBalance(apiKeyId)) return executor;
  const wrapped = Object.create(executor) as T;
  wrapped.execute = async (args) => {
    // Audit concrete implementations, not provider IDs: custom executors can hide retries,
    // multi-request generations or synthesized usage. They need their own meter integration.
    if (
      ![
        BaseExecutor.prototype.execute,
        DefaultExecutor.prototype.execute,
        CliproxyapiExecutor.prototype.execute,
        DarioExecutor.prototype.execute,
      ].includes(executor.execute)
    )
      throw new PrepaidInferenceError();
    return executePrepaidInference(apiKeyId, provider, args, async () =>
      normalizeExecutorResult(
        await executor.execute({ ...args, singleDispatch: true, skipUpstreamRetry: true })
      )
    );
  };
  return wrapped;
}

export async function executePrepaidInference<T extends { response: Response }>(
  apiKeyId: string | null | undefined,
  provider: string,
  args: { model: string; body: unknown; signal?: AbortSignal | null },
  execute: () => Promise<T>
): Promise<T> {
  if (!apiKeyId || !getPrepaidBalance(apiKeyId)) return execute();
  try {
    assertPrepaidChatBody(args.body);
    const body = args.body;
    const billing = await quote(
      provider,
      args.model,
      typeof body.service_tier === "string" ? body.service_tier : undefined
    );
    args.signal?.throwIfAborted();
    const id = randomUUID();
    reservePrepaid(apiKeyId, id, billing.maximumUsd, billing);
    dispatchPrepaid(id);
    const result = await runWithSingleDispatch(execute);
    // HTTP status alone does not establish zero billable work (e.g. gateway 408).
    // Failed attempts remain held until evidence-backed reconciliation.
    if (!result.response.ok) return result;
    return { ...result, response: meterResponse(result.response, id, billing) };
  } catch (error) {
    if (error instanceof PrepaidError)
      throw new PrepaidInferenceError(error.code === "insufficient_funds" ? 402 : 503);
    throw error;
  }
}
