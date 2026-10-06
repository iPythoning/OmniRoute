import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth.ts";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { resolveClientApiKey } from "@/sse/services/auth.ts";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";
import { prepaidRequestRejection } from "@/lib/prepaid/policy";

const HANDSHAKE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isWsHandshake(ctx: PolicyContext): boolean {
  if (ctx.classification.normalizedPath !== "/api/v1/ws") return false;
  if (!HANDSHAKE_METHODS.has(ctx.request.method.toUpperCase())) return false;

  try {
    return new URL(ctx.request.url, "http://localhost").searchParams.get("handshake") === "1";
  } catch {
    return false;
  }
}

function maskKeyId(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `key_${tail}`;
}

export const clientApiPolicy: RoutePolicy = {
  routeClass: "CLIENT_API",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const { key: bearer, conflicting } = resolveClientApiKey(ctx.request as Request);
    if (conflicting) return reject(400, "AUTH_002", "Conflicting API credentials");
    if (!bearer) {
      // The WS descriptor handshake is a metadata read; the route handler
      // performs the actual wsAuth/dashboard/API-key decision and returns the
      // protocol details the browser needs before opening the socket.
      if (isWsHandshake(ctx)) {
        return allow({ kind: "anonymous", id: "ws-handshake" });
      }

      if (await isDashboardSessionAuthenticated(ctx.request)) {
        return allow({ kind: "dashboard_session", id: "dashboard" });
      }

      if (!isRequireApiKeyEnabled()) {
        return allow({ kind: "anonymous", id: "local" });
      }

      return reject(401, "AUTH_002", "Authentication required");
    }

    const { validateApiKey, getApiKeyMetadata } = await import("../../../lib/db/apiKeys");
    const ok = await validateApiKey(bearer);
    if (!ok) {
      // Issue #2257: when REQUIRE_API_KEY is off, a stale CLI config (Codex
      // Desktop auto-config, Hermes, etc.) carrying an invalid Bearer
      // shouldn't 401 the whole request — REQUIRE_API_KEY=false means
      // "anonymous traffic is allowed", so an invalid key should degrade to
      // anonymous instead of rejecting. We log a warning so the bad key is
      // still observable in the request log.
      if (!isRequireApiKeyEnabled()) {
        console.warn(
          `[clientApiPolicy] invalid bearer presented to ${ctx.classification.normalizedPath} ` +
            `but REQUIRE_API_KEY=false — falling through to anonymous (key_id=${maskKeyId(bearer)})`
        );
        return allow({ kind: "anonymous", id: "local" });
      }
      return reject(401, "AUTH_002", "Invalid API key");
    }

    const metadata = await getApiKeyMetadata(bearer);
    const prepaidRejection = metadata
      ? prepaidRequestRejection(metadata.id, ctx.request as Request)
      : null;
    if (prepaidRejection)
      return reject(prepaidRejection.status, "PREPAID_UNAVAILABLE", prepaidRejection.message);
    return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
  },
};
