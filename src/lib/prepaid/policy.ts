import { getPrepaidBalance, parseUsdNanos } from "@/lib/db/prepaid";

export function prepaidRequestRejection(
  apiKeyId: string,
  request: Request
): { status: number; message: string } | null {
  try {
    const prepaid = getPrepaidBalance(apiKeyId);
    if (!prepaid) return null;
    const pathname = request.url.startsWith("/")
      ? request.url.split("?")[0]
      : new URL(request.url).pathname;
    const path = pathname.replace(/^\/api\//, "/");
    if (request.method === "GET" && path === "/v1/models") return null;
    // Protocol capabilities, not a configurable model allow-list. Each allowed write shares chatCore's meter.
    if (
      request.method !== "POST" ||
      !["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/search"].includes(path)
    ) {
      return { status: 403, message: "This endpoint is not available for prepaid keys" };
    }
    if (parseUsdNanos(prepaid.availableUsd) === 0)
      return { status: 402, message: "Insufficient prepaid balance" };
    return null;
  } catch {
    return { status: 503, message: "Prepaid account temporarily unavailable" };
  }
}
