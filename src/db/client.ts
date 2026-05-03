import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getDBURL } from "./internal/config.js";
import * as schema from "./schema.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

const client = createClient({ url: getDBURL() });
await client.execute("PRAGMA foreign_keys = ON");
export const db = drizzle(client, { schema });
