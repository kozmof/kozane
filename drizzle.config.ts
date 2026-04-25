import { defineConfig } from "drizzle-kit";
import { getDBURL } from "./src/db/internal/config.js";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: getDBURL(),
  },
});
