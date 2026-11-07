import { prepareInput } from "@kozane/core/services";
import { ValidationError } from "@kozane/core";
import { BackendError, type BackendErrorCode } from "./contract.js";

const DOMAIN_CODES = new Set<BackendErrorCode>([
  "validation",
  "not_found",
  "conflict",
  "limit",
  "unavailable",
]);
const FALLBACK: Record<number, BackendErrorCode> = {
  400: "validation",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "limit",
  429: "rate_limited",
};
const MESSAGES: Record<BackendErrorCode, string> = {
  validation: "The request was not accepted",
  not_found: "The requested record was not found",
  conflict: "The request conflicts with current data",
  limit: "The request exceeds a limit",
  read_only: "This backend is read-only",
  unauthenticated: "Authentication is required",
  forbidden: "Permission denied",
  rate_limited: "Too many requests. Try again later",
  unavailable: "The backend is unavailable",
  network: "Unable to reach the backend",
};
export const KEEPALIVE_BYTES_MAX = 60 * 1024;
export function retryAfterMilliseconds(value: string | null, wallTime: number): number {
  if (value === null) return 1000;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const delay = Number(raw) * 1000;
    return Number.isFinite(delay) ? delay : 1000;
  }
  if (
    !/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:,| )/i.test(
      raw,
    )
  )
    return 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > wallTime ? date - wallTime : 1000;
}

export interface HttpTransportOptions {
  fetcher?: typeof fetch;
  monotonicNow?: () => number;
  wallNow?: () => number;
}
/** Internal HTTP details stay behind the backend API. Rejected mutations are never retained. */
export class HttpTransport {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private throttleUntil = 0;
  constructor(
    private readonly url: (path: string) => string,
    options: HttpTransportOptions = {},
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
  }
  get retryAfterMs(): number {
    return Math.max(0, this.throttleUntil - this.now());
  }
  async request(
    path: string,
    method = "GET",
    input?: unknown,
    options: {
      keepalive?: boolean;
      headers?: RequestInit["headers"];
      allowNotModified?: boolean;
      cache?: RequestInit["cache"];
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    let body: string | undefined;
    if (input !== undefined) {
      try {
        body = JSON.stringify(prepareInput(input));
      } catch (error) {
        if (error instanceof ValidationError) throw new BackendError("validation", error.message);
        throw error;
      }
    }
    const remaining = this.retryAfterMs;
    if (remaining > 0)
      throw new BackendError("rate_limited", MESSAGES.rate_limited, { retryAfterMs: remaining });
    const headers = new Headers(options.headers);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetcher(this.url(path), {
        method,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cache ? { cache: options.cache } : {}),
        headers,
        body,
        keepalive:
          options.keepalive === true &&
          body !== undefined &&
          new TextEncoder().encode(body).byteLength <= KEEPALIVE_BYTES_MAX,
      });
    } catch (cause) {
      throw new BackendError("network", MESSAGES.network, { cause });
    }
    if (response.ok || (options.allowNotModified && response.status === 304)) return response;
    const authoritative = FALLBACK[response.status];
    const header = response.headers.get("X-Kozane-Error-Code") as BackendErrorCode | null;
    const code = [401, 403, 429].includes(response.status)
      ? authoritative
      : header && DOMAIN_CODES.has(header)
        ? header
        : (authoritative ?? "unavailable");
    let retryAfterMs: number | undefined;
    if (code === "rate_limited") {
      const delay = retryAfterMilliseconds(response.headers.get("retry-after"), this.wallNow());
      this.throttleUntil = Math.max(this.throttleUntil, this.now() + delay);
      retryAfterMs = this.retryAfterMs;
    }
    let message = MESSAGES[code];
    if (
      response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
      "application/json"
    ) {
      try {
        const value: unknown = await response.json();
        if (
          value !== null &&
          typeof value === "object" &&
          "message" in value &&
          typeof value.message === "string" &&
          value.message.trim()
        )
          message = value.message;
      } catch {
        /* Keep the safe status message. */
      }
    }
    throw new BackendError(code, message, { retryAfterMs });
  }
}
