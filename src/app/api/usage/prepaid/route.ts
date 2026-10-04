import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  creditPrepaid,
  getPrepaidBalance,
  refundPrepaid,
  settlePrepaid,
  listPrepaidReservations,
  listPrepaidEntries,
  PrepaidError,
} from "@/lib/db/prepaid";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";

const identifier = z.string().uuid();
const amountUsd = z.string();
const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("credit"), apiKeyId: identifier, amountUsd }).strict(),
  z.object({ kind: z.literal("refund"), chargeId: identifier, amountUsd }).strict(),
  z
    .object({
      kind: z.literal("reconcile"),
      reservationId: identifier,
      amountUsd,
      evidence: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

function failure(error: unknown): Response {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(buildErrorBody(400, "Invalid prepaid request"), { status: 400 });
  }
  if (error instanceof PrepaidError) {
    const status = {
      not_found: 404,
      conflict: 409,
      invalid_amount: 400,
      insufficient_funds: 402,
      unavailable: 503,
    }[error.code];
    return Response.json(
      buildErrorBody(status, "Prepaid operation could not be completed", error.code),
      { status }
    );
  }
  return Response.json(buildErrorBody(503, "Prepaid account temporarily unavailable"), {
    status: 503,
  });
}

export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  try {
    const params = new URL(request.url).searchParams;
    const apiKeyId = identifier.parse(params.get("apiKeyId"));
    const balance = getPrepaidBalance(apiKeyId);
    if (!balance) throw new PrepaidError("not_found");
    const view = z.enum(["reservations", "entries"]).parse(params.get("view") ?? "reservations");
    const records = params.has("limit")
      ? (view === "entries" ? listPrepaidEntries : listPrepaidReservations)(
          apiKeyId,
          z.coerce.number().int().min(1).max(100).parse(params.get("limit")),
          z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(params.get("after") ?? "0")
        )
      : undefined;
    return Response.json(
      { ...balance, ...(records && { [view]: records }) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  try {
    const id = identifier.parse(request.headers.get("Idempotency-Key"));
    const validation = operation.safeParse(await request.json());
    if (!validation.success) throw validation.error;
    const input = validation.data;
    if (input.kind === "reconcile" && id !== input.reservationId)
      throw new PrepaidError("conflict");
    const balance =
      input.kind === "credit"
        ? creditPrepaid(input.apiKeyId, id, input.amountUsd)
        : input.kind === "refund"
          ? refundPrepaid(input.chargeId, id, input.amountUsd)
          : settlePrepaid(input.reservationId, input.amountUsd, input.evidence);
    return Response.json({ entryId: id, ...balance }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
