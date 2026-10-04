import { reservePrepaid, PrepaidError } from "../../src/lib/db/prepaid.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

try {
  reservePrepaid(process.argv[2], process.argv[3], process.argv[4]);
  process.send?.({ admitted: true });
} catch (error) {
  if (!(error instanceof PrepaidError) || error.code !== "insufficient_funds") throw error;
  process.send?.({ admitted: false });
} finally {
  resetDbInstance();
}
