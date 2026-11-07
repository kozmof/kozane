import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
/** A disposable service-backed HTTP fixture. Dependencies are public packed entries in consumer checks.
 * @param {{database: any, services: any, schema: any, migrate: any, HttpBackend: any, domainErrorCode: any}} dependencies
 */
export async function createServiceContractFixture(dependencies) {
  const { database, services, schema, migrate, HttpBackend, domainErrorCode } = dependencies;
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const handle = drizzle(
    async (sql, args, method) => {
      const statement = sqlite.prepare(sql);
      statement.setReturnArrays(true);
      const rows = /** @type {unknown[][]} */ (/** @type {unknown} */ (statement.all(...args)));
      return { rows: method === "get" ? rows[0] : rows };
    },
    { schema },
  );
  /** @param {string} begin @param {any} operation */
  async function transaction(begin, operation) {
    sqlite.exec(begin);
    try {
      const result = await operation(handle);
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  const db = database.createDatabaseAdapter(handle, {
    write: (/** @type {any} */ operation) => transaction("BEGIN IMMEDIATE", operation),
    read: (/** @type {any} */ operation) => transaction("BEGIN DEFERRED", operation),
    migrate: async (/** @type {any} */ prepare) => {
      const plan = await prepare(handle);
      sqlite.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
      try {
        for (const statement of plan) {
          if (statement.args.length) sqlite.prepare(statement.sql).run(...statement.args);
          else sqlite.exec(statement.sql);
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        sqlite.exec("PRAGMA foreign_keys=ON");
      }
    },
  });
  try {
    await migrate(db);
    const context = database.createServiceContext();
    const seed = await services.namespaces.create(db, context, { name: "Contract fixture" });
    const backend = new HttpBackend({
      capabilities: {
        writable: true,
        persistent: false,
        taskspaces: false,
        externalWrites: false,
        auth: false,
      },
      /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
      fetcher: async (input, init) => {
        const url = new URL(String(input), "http://contract.test");
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        try {
          let result;
          if (url.pathname === "/api/namespaces")
            result =
              method === "POST"
                ? await services.namespaces.create(db, context, body)
                : await services.namespaces.list(db, context);
          else if (parts[0] === "api" && parts[1] === "namespaces")
            result = await services.namespaces.get(db, context, parts[2]);
          else if (url.pathname === "/api/tags") result = await services.tags.view(db, context);
          else if (url.pathname === "/api/map") result = await services.map.get(db, context);
          else if (parts[1] === "api" && parts[2] === "snapshot") {
            const data = await services.snapshot.get(db, context, parts[0]);
            if (!data) return Response.json({ message: "Namespace not found" }, { status: 404 });
            result = data.snapshot;
          } else if (parts[1] === "api" && parts[2] === "warp-directory") {
            const rows = await services.warpDirectory.readRows(db, context, parts[0]);
            if (rows.warps.length)
              throw new Error("Fixture does not support populated warp directories");
            result = [];
          } else if (parts[1] === "api" && parts[2] === "cards") {
            if (method === "POST")
              result = await services.cards.create(db, context, parts[0], body);
            else if (method === "PATCH")
              result = await services.cards.update(db, context, parts[0], parts[3], body);
            else if (method === "DELETE")
              result = await services.cards.removeOne(db, context, parts[0], parts[3]);
            else throw new Error("Unsupported card fixture request");
          } else throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
          return Response.json(result);
        } catch (error) {
          const code = domainErrorCode(error);
          if (!code) throw error;
          return Response.json(
            { message: error instanceof Error ? error.message : String(error) },
            { status: code === "not_found" ? 404 : 400, headers: { "X-Kozane-Error-Code": code } },
          );
        }
      },
    });
    return { backend, namespaceId: seed.id, cleanup: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
