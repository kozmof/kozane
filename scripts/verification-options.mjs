import { resolve } from "node:path";
/** Reusing archives never builds; retaining output prepares one candidate for later checks. */
export function verificationOptions(args) {
  if (args.length === 0) return { mode: "temporary" };
  if (args.length === 1) {
    for (const [flag, mode] of [
      ["--artifacts=", "reuse"],
      ["--output=", "retain"],
    ]) {
      if (args[0].startsWith(flag) && args[0].length > flag.length)
        return { mode, directory: resolve(args[0].slice(flag.length)) };
    }
  }
  throw new Error("Usage: verify-workspace.mjs [--artifacts=<directory> | --output=<directory>]");
}
