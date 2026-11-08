import { describe, expect, it } from "vitest";
import { readJsonObject } from "./request.js";

async function expectHttpRejection(promise: Promise<unknown>, status: number, message: string) {
  await expect(promise).rejects.toMatchObject({ status, body: { message } });
}

describe("readJsonObject", () => {
  const json = { "content-type": "application/json" };

  it("returns parsed JSON objects", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "Card" }),
    });

    await expect(readJsonObject(request)).resolves.toEqual({ title: "Card" });
  });

  it("accepts parameters and any casing on the content type", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      body: "{}",
    });

    await expect(readJsonObject(request)).resolves.toEqual({});
  });

  it("refuses a body not sent as application/json, CORS-simple ones above all", async () => {
    // Test absent and text/plain content types, which cross-origin simple requests can send.
    const unsent = new Request("http://localhost", {
      method: "POST",
      body: new Blob(['{"title":"Card"}']),
    });
    expect(unsent.headers.get("content-type")).toBeNull();
    const plain = new Request("http://localhost", { method: "POST", body: '{"title":"Card"}' });

    for (const request of [unsent, plain])
      await expectHttpRejection(
        readJsonObject(request),
        415,
        "Request body must be sent as application/json",
      );
  });

  it("rejects invalid JSON", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: json,
      body: "{nope",
    });

    await expectHttpRejection(readJsonObject(request), 400, "Request body must be valid JSON");
  });

  it("rejects non-object JSON bodies", async () => {
    for (const body of ["null", "[]", '"text"']) {
      const request = new Request("http://localhost", { method: "POST", headers: json, body });
      await expectHttpRejection(readJsonObject(request), 400, "Request body must be a JSON object");
    }
  });
});
