import { NextResponse } from "next/server";
import {
  getApiKeys,
  getApiKeysCount,
  createApiKey,
  ApiKeyIssuanceConflictError,
} from "@/lib/db/apiKeys";
import { isCloudEnabled } from "@/lib/db/settings";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { createKeySchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { isApiKeyRevealEnabled, maskStoredApiKey } from "@/lib/apiKeyExposure";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { normalizeSelfServiceScopesForCreate } from "@/shared/constants/selfServiceScopes";
import * as log from "@/sse/utils/logger";
import { idempotencyKeySchema } from "@/shared/validation/schemas/keys";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";

function parsePagination(request: Request) {
  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit");
  const offsetValue = url.searchParams.get("offset");

  const parsedLimit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
  const parsedOffset = offsetValue ? Number.parseInt(offsetValue, 10) : 0;

  const limit =
    Number.isInteger(parsedLimit) && parsedLimit && parsedLimit > 0 ? parsedLimit : null;
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  return { limit, offset };
}

// GET /api/keys - List API keys
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { limit, offset } = parsePagination(request);
    const dbLimit = limit ?? undefined;
    const total = getApiKeysCount();
    const keys = await getApiKeys(dbLimit, offset);
    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskStoredApiKey(k.key),
    }));

    return NextResponse.json({
      keys: maskedKeys,
      total,
      allowKeyReveal: isApiKeyRevealEnabled(),
    });
  } catch (error) {
    log.error("keys", "Error fetching keys", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
    if (idempotencyKey !== undefined && !idempotencyKeySchema.safeParse(idempotencyKey).success) {
      return NextResponse.json(buildErrorBody(400, "Idempotency-Key must be a UUID"), {
        status: 400,
      });
    }
    const body = await request.json();

    // Zod validation
    const validation = validateBody(createKeySchema, body);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { name, scopes, ...options } = validation.data;
    if (idempotencyKey || options.prepaidEnabled) {
      const issuanceAuthError = await requireManagementAuth(request, { alwaysRequireAuth: true });
      if (issuanceAuthError) return issuanceAuthError;
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const normalizedScopes = normalizeSelfServiceScopesForCreate(scopes);
    const apiKey = await createApiKey(name, machineId, normalizedScopes, {
      ...options,
      idempotencyKey,
    });

    // Auto sync to Cloud if enabled — fire-and-forget. Cloud sync is a
    // background side-effect, not part of the key-creation contract, and it
    // performs an outbound network call. Awaiting it here blocked the HTTP
    // response on a slow/unreachable Cloud endpoint (e.g. a fresh/offline
    // install with a misconfigured or unreachable CLOUD_URL): the request
    // would hang until the fetch settled or timed out (#6570). Errors inside
    // syncKeysToCloudIfEnabled() are already caught and logged internally, so
    // this is safe to leave unawaited.
    if (!apiKey.replayed) void syncKeysToCloudIfEnabled();

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
        allowedConnections: apiKey.allowedConnections,
        noLog: apiKey.noLog,
        allowUsageCommand: apiKey.allowUsageCommand,
        usageLimitEnabled: apiKey.usageLimitEnabled,
        dailyUsageLimitUsd: apiKey.dailyUsageLimitUsd,
        weeklyUsageLimitUsd: apiKey.weeklyUsageLimitUsd,
        chaosModeEnabled: apiKey.chaosModeEnabled,
        streamDefaultMode: apiKey.streamDefaultMode,
        compressionEnabled: apiKey.compressionEnabled,
        cacheDefaultMode: apiKey.cacheDefaultMode,
        modelAccessMode: apiKey.modelAccessMode,
        allowedModels: apiKey.allowedModels,
        allowedCombos: apiKey.allowedCombos,
        isActive: apiKey.isActive,
        prepaidEnabled: apiKey.prepaidEnabled,
      },
      { status: apiKey.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(buildErrorBody(400, "Invalid JSON request"), { status: 400 });
    }
    if (error instanceof ApiKeyIssuanceConflictError) {
      return NextResponse.json(
        buildErrorBody(
          409,
          "Issuance request conflicts with an existing receipt or retired credential"
        ),
        { status: 409 }
      );
    }
    log.error("keys", "Error creating key", error);
    return NextResponse.json(buildErrorBody(500, "Failed to create key"), { status: 500 });
  }
}

/**
 * Sync API keys to Cloud if enabled
 */
async function syncKeysToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    log.error("keys", "Error syncing keys to cloud", error);
  }
}
