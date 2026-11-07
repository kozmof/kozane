import { cpSync, rmSync } from "node:fs";
const source = new URL("../drizzle", import.meta.url);
const target = new URL("../packages/kozane/drizzle", import.meta.url);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
