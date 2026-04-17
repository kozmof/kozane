import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const version = 'v1';

export default defineConfig({
  out: './drizzle',
  schema: `./src/db/${version}/schema.ts`,
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME!,
  },
});
