import { ValidationError } from "@kozane/core";
import { ClientError, HttpClient } from "@kozane/client";
/** Execute in both Node and the production browser, using only public package entries. */
export async function verifyCoreIdentity() {
  const coreError = new ValidationError("Application core runtime identity");
  const backend = new HttpClient({
    capabilities: {
      writable: true,
      persistent: false,
      taskspaces: false,
      externalWrites: false,
      auth: false,
    },
    fetcher: async () => {
      throw new Error("Identity check must fail before network dispatch");
    },
  });
  const input = new Proxy(
    { width: 1 },
    {
      getPrototypeOf() {
        throw coreError;
      },
    },
  );
  try {
    await backend.cards.update("n", "c", input);
  } catch (error) {
    if (
      error instanceof ClientError &&
      error.code === "validation" &&
      error.message === coreError.message
    )
      return;
    throw new Error("Client did not recognize the application's public core error", {
      cause: error,
    });
  }
  throw new Error("Client accepted the identity probe input");
}
