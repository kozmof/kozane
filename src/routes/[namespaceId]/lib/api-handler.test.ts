import { describe, expect, it } from "vitest";
import { error, isHttpError } from "@sveltejs/kit";
import { DefaultLayerError, DefaultPartitionError, NotFoundError } from "$db/api/utils";
import { API_HANDLER, apiHandler, httpErrorFromDb } from "./api-handler.js";

function sqliteError(message: string): Error {
  return new Error("SQLITE_CONSTRAINT", { cause: new Error(message) });
}

function expectHttp(value: unknown, status: number, message: string) {
  expect(isHttpError(value)).toBe(true);
  expect(value).toMatchObject({ status, body: { message } });
}

describe("httpErrorFromDb", () => {
  it("maps NotFoundError to 404 with its own message", () => {
    expectHttp(httpErrorFromDb(new NotFoundError("Layer x")), 404, "Layer x not found");
  });

  it("uses the route's not-found wording when given", () => {
    expectHttp(
      httpErrorFromDb(new NotFoundError("Area x"), { notFound: "Scope area not found" }),
      404,
      "Scope area not found",
    );
  });

  it("maps default-row deletions to 400", () => {
    expectHttp(httpErrorFromDb(new DefaultLayerError()), 400, "Cannot delete the default layer");
    expectHttp(
      httpErrorFromDb(new DefaultPartitionError()),
      400,
      "Cannot delete the default partition",
    );
  });

  it("maps foreign-key failures to 404, found anywhere in the cause chain", () => {
    const e = sqliteError("FOREIGN KEY constraint failed");
    expectHttp(httpErrorFromDb(e), 404, "A referenced record was not found");
    expectHttp(
      httpErrorFromDb(e, { foreignKey: "Namespace not found" }),
      404,
      "Namespace not found",
    );
  });

  it("maps unique-constraint failures to 409", () => {
    expectHttp(
      httpErrorFromDb(sqliteError("UNIQUE constraint failed: layer.name")),
      409,
      "That record already exists",
    );
  });

  it("returns other errors unchanged, including SvelteKit's own", () => {
    const plain = new Error("disk full");
    expect(httpErrorFromDb(plain)).toBe(plain);
    let http: unknown;
    try {
      error(418, "teapot");
    } catch (e) {
      http = e;
    }
    expect(httpErrorFromDb(http)).toBe(http);
  });
});

describe("apiHandler", () => {
  it("passes the event through and returns the handler's response", async () => {
    const handler = apiHandler(async (event: { n: number }) => new Response(String(event.n)));
    await expect((await handler({ n: 7 })).text()).resolves.toBe("7");
  });

  it("turns a database error thrown by the handler into an HTTP error", async () => {
    const handler = apiHandler(async () => {
      throw new NotFoundError("Warp w");
    });
    await expect(handler(undefined as never)).rejects.toMatchObject({
      status: 404,
      body: { message: "Warp w not found" },
    });
  });
});

describe("namespace API routes", () => {
  const routes = import.meta.glob<Record<string, unknown>>("../api/**/+server.ts", {
    eager: true,
  });

  it("finds the route modules", () => {
    expect(Object.keys(routes).length).toBeGreaterThan(20);
  });

  it.each(Object.entries(routes))("%s wraps every handler with apiHandler", (_path, module) => {
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      const handler = module[method];
      if (handler === undefined) continue;
      expect((handler as Record<symbol, unknown>)[API_HANDLER], `${method} is not wrapped`).toBe(
        true,
      );
    }
  });
});
