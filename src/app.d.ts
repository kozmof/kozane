import type { DB } from "./db/client";

// See https://svelte.dev/docs/kit/types#app.d.ts for these interface definitions.
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      requestId: string;
      db: DB;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
