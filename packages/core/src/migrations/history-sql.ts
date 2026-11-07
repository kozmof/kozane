// Match the original Drizzle migration-history table format.
export const migrationHistoryTableSql = `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
)`;
