import { getDbInstance } from "./core";

export function getDurableDbInstance() {
  const db = getDbInstance();
  if (db.driver === "sql.js" || db.name === ":memory:") {
    throw new Error("Durable operations require a file-backed SQLite driver");
  }
  // WAL NORMAL protects process crashes, but can lose acknowledged commits on power loss.
  // Never switch pragmas mid-transaction: callers entering an outer transaction set this first.
  if (db.pragma("synchronous", { simple: true }) !== 2) {
    if (db.inTransaction) throw new Error("Durable transaction was not initialized");
    db.pragma("synchronous = FULL");
  }
  return db;
}
