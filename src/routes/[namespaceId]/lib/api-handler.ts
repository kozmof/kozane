import { error } from "@sveltejs/kit";
import {
  DefaultLayerError,
  DefaultPartitionError,
  NotFoundError,
  isForeignKeyError,
  isUniqueConstraintError,
} from "$db/api/utils";

/**
 * Route-specific wording for database failures. Each one replaces the generic message for that
 * kind of failure. The status stays the same.
 */
export type DbErrorMessages = {
  /** For a `NotFoundError`. Defaults to the error's own message. */
  notFound?: string;
  /** For a foreign-key failure, such as a namespace deleted while the request ran. */
  foreignKey?: string;
  /** For a unique-constraint failure, such as a duplicate name. */
  unique?: string;
};

/**
 * Translate a database error into the HTTP error it stands for. Return any other value
 * unchanged, including SvelteKit's own `error()` and `redirect()` results, so it keeps its
 * meaning.
 *
 * - `NotFoundError` → 404
 * - `DefaultPartitionError`, `DefaultLayerError` → 400
 * - foreign-key failure → 404, because a referenced row is gone
 * - unique-constraint failure → 409
 */
export function httpErrorFromDb(e: unknown, messages: DbErrorMessages = {}): unknown {
  try {
    if (e instanceof NotFoundError) error(404, messages.notFound ?? e.message);
    if (e instanceof DefaultPartitionError || e instanceof DefaultLayerError) error(400, e.message);
    if (isForeignKeyError(e))
      error(404, messages.foreignKey ?? "A referenced record was not found");
    if (isUniqueConstraintError(e)) error(409, messages.unique ?? "That record already exists");
  } catch (httpError) {
    return httpError;
  }
  return e;
}

/** Marks a handler wrapped by {@link apiHandler}, so a test can check every API route uses it. */
export const API_HANDLER = Symbol("kozane.apiHandler");

/**
 * Wrap a route handler so database errors it does not handle itself become 4xx responses
 * instead of 500s. A route that catches an error first keeps its own response.
 */
export function apiHandler<E>(
  handler: (event: E) => Promise<Response>,
  messages: DbErrorMessages = {},
): (event: E) => Promise<Response> {
  const wrapped = async (event: E): Promise<Response> => {
    try {
      return await handler(event);
    } catch (e) {
      throw httpErrorFromDb(e, messages);
    }
  };
  Object.defineProperty(wrapped, API_HANDLER, { value: true });
  return wrapped;
}
