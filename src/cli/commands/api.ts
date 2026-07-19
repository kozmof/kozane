import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { API_KEY_FILE, apiKeyPath, type ApiKeyFile } from "../../lib/server/api-key.js";
import { requireWorkspace } from "../lib/project.js";

function writeNewApiKey(root: string): string {
  const apiKey = randomBytes(32).toString("base64url");
  const contents: ApiKeyFile = { apiKey, createdAt: new Date().toISOString() };
  const path = apiKeyPath(root);
  writeFileSync(path, JSON.stringify(contents, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return apiKey;
}

export function apiGenerate(): void {
  const { root } = requireWorkspace();
  if (existsSync(apiKeyPath(root))) {
    console.error(`An API key already exists in .kozane/${API_KEY_FILE}.`);
    console.error('Run "kozane api key refresh" to replace it.');
    process.exitCode = 1;
    return;
  }
  const apiKey = writeNewApiKey(root);
  console.log("API key generated. Save it now; requests must include it once the server starts.");
  console.log(apiKey);
}

export function apiRefresh(): void {
  const { root } = requireWorkspace();
  if (!existsSync(apiKeyPath(root))) {
    console.error(`No API key exists in .kozane/${API_KEY_FILE}.`);
    console.error('Run "kozane api key generate" first.');
    process.exitCode = 1;
    return;
  }
  const apiKey = writeNewApiKey(root);
  console.log("API key refreshed. The previous key is no longer valid.");
  console.log(apiKey);
}
