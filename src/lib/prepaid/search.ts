import { randomUUID } from "node:crypto";
import { runWithSingleDispatch } from "@omniroute/open-sse/utils/proxyFetch";
import {
  dispatchPrepaid,
  formatUsdNanos,
  getPrepaidBalance,
  reservePrepaid,
  settlePrepaid,
  PrepaidError,
} from "@/lib/db/prepaid";

type SearchResult = { success: boolean; status?: number; error?: string };

export async function executePrepaidSearch<T extends SearchResult>(
  apiKeyId: string | undefined,
  config: { id: string; costPerQuery: number; transport?: "mcp" },
  execute: () => Promise<T>,
  onReservation?: (id: string) => void
): Promise<T | SearchResult> {
  try {
    if (!apiKeyId || !getPrepaidBalance(apiKeyId)) return await execute();
    const nanos = Math.round(config.costPerQuery * 1e9);
    if (
      !Number.isFinite(config.costPerQuery) ||
      config.costPerQuery < 0 ||
      !Number.isSafeInteger(nanos)
    )
      throw new PrepaidError("unavailable");
    // The existing search contract prices one query at the selected provider's configured tariff.
    const amount = formatUsdNanos(nanos);
    const id = randomUUID();
    reservePrepaid(apiKeyId, id, amount, { provider: config.id, queryPriceUsd: amount });
    onReservation?.(id);
    dispatchPrepaid(id);
    const result = await runWithSingleDispatch(execute, { protocol: config.transport });
    if (result.success) settlePrepaid(id, amount);
    // Error outcomes remain reserved: a provider may have processed a request before returning an error.
    return result;
  } catch (error) {
    if (error instanceof PrepaidError)
      return {
        success: false,
        status: error.code === "insufficient_funds" ? 402 : 503,
        error: "Prepaid search could not be completed",
      };
    throw error;
  }
}
