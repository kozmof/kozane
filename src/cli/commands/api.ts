import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  API_KEY_FILE,
  apiKeyPath,
  writeApiKey,
  type ApiKeyFile,
} from "../../lib/server/api-key.js";
import { requireWorkspace } from "../lib/project.js";

function writeNewApiKey(root: string): string {
  const apiKey = randomBytes(32).toString("base64url");
  const contents: ApiKeyFile = { apiKey, createdAt: new Date().toISOString() };
  writeApiKey(root, contents);
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
