import type { DB } from "./db/client";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      db: DB;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
