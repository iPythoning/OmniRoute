import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

try {
  const result = await createApiKey("multiprocess", "test-machine", [], {
    idempotencyKey: process.argv[2],
  });
  process.send?.({ id: result.id, replayed: result.replayed });
} finally {
  resetDbInstance();
}
