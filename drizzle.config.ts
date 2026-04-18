import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const version = "v1";

export default defineConfig({
  out: "./drizzle",
  schema: `./src/db/${version}/schema.ts`,
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
