import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it } from "vitest";

// 0003 は、対応する受渡しが無い古い再送記録があっても、全記録を失わずに終わる。
it("keeps old receipts that have a handoff and drops only the orphaned ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-matching-orphan-"));
  const db = createClient({ url: `file:${dir}/matching.db` });
  try {
    const migrations = new URL("../../../db/matching/", import.meta.url);
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      await db.executeMultiple(readFileSync(new URL(file, migrations), "utf8"));
      if (file === "0001_initial.sql") {
        await db.executeMultiple(`
          INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at)
            VALUES ('one','campus','giver','RESERVED',0);
          INSERT INTO applications VALUES ('a','one','campus','alice','','[]','walk',0,'SELECTED',0);
          INSERT INTO handoffs VALUES ('original','one','a','giver','alice','PROPOSED',4070908800000,1,0,0);
          INSERT INTO idempotency_keys VALUES ('kept','original','{}',0), ('orphan','deleted-handoff','{}',0);
        `);
      }
    }
    const rows = (await db.execute("SELECT key, listing_id FROM idempotency_keys ORDER BY key")).rows;
    expect(rows.map((row) => [row.key, row.listing_id])).toEqual([["kept", "one"]]);
    const leftovers = await db.execute("SELECT name FROM sqlite_master WHERE name = 'old_idempotency_keys'");
    expect(leftovers.rows).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
