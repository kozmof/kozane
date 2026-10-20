-- Add timestamp columns with a constant default, then backfill existing cards with the
-- migration time. SQLite requires a non-null default when adding a NOT NULL column and
-- does not allow a parenthesized expression such as unixepoch() for that default.
--
-- DEFAULT 0 remains in the schema and meta/0011_snapshot.json. Every insert must supply
-- both timestamps to avoid storing the Unix epoch. Drizzle's $defaultFn supplies them
-- through cardTable, and db import includes both columns. Raw inserts that omit them
-- receive the zero default.
--
-- Existing cards have no recorded history. Both timestamps start at the migration time,
-- so kozane card list --sort gap reports zero until their text changes. unixepoch()
-- returns seconds, matching Drizzle's integer({ mode: "timestamp" }) storage.
ALTER TABLE `card` ADD `created_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `card` ADD `updated_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `card` SET `created_at` = unixepoch(), `updated_at` = unixepoch();
