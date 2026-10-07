/** Parses a port from user input (flag or env var). Returns null when it is not a valid port. */
export function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

export type PortSources = {
  /** `--port` flag. */
  flag?: string;
  /** Value of the env var, already read by the caller. */
  env?: string;
  /** Env var name, used in the error message. */
  envName?: string;
  /** `server.port` from `.kozane/config.json`. */
  config?: number;
  /** Built-in default used when nothing else is set. */
  fallback: number;
};

/**
 * Resolve the port from the flag, environment, configuration, then default. Reject invalid
 * explicit values.
 */
export function resolvePort({
  flag,
  env,
  envName = "KOZANE_PORT",
  config,
  fallback,
}: PortSources): number {
  if (flag !== undefined) {
    const port = parsePort(flag);
    if (port === null) {
      throw new Error(`Invalid --port "${flag}". Use a number between 0 and 65535.`);
    }
    return port;
  }
  if (env !== undefined && env.trim() !== "") {
    const port = parsePort(env);
    if (port === null) {
      throw new Error(`Invalid ${envName} "${env}". Use a number between 0 and 65535.`);
    }
    return port;
  }
  if (config !== undefined) return config;
  return fallback;
}
