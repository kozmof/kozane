-- Hand-edited after `drizzle-kit generate`. The generated pair was
--   ALTER TABLE `card` ADD `created_at` integer NOT NULL;
-- which SQLite refuses outright: a NOT NULL column added by ALTER TABLE needs a non-null
-- default, and that default may not be an expression in parentheses, so `unixepoch()`
-- cannot be written there either. The constant gets the columns in; the UPDATE puts the
-- real value in every existing row.
--
-- `DEFAULT 0` outlives this migration: SQLite cannot drop a column default, so it is a
-- permanent property of the table and is recorded as such in `meta/0011_snapshot.json`.
-- Every insert must therefore write both columns itself. Drizzle's `$defaultFn` does that
-- on every insert through `cardTable`, and `db import` names both columns; a raw `INSERT
-- INTO card` that omits them takes the default and lands at the epoch rather than failing.
--
-- Cards that predate this migration have no recorded history, so both columns get the
-- moment the migration ran: they read as created now and never since edited, and the
-- interval `kozane card list --sort gap` reports stays zero for them until their text is
-- next changed. `unixepoch()` returns seconds, which is what drizzle's
-- `integer({ mode: "timestamp" })` stores.
ALTER TABLE `card` ADD `created_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `card` ADD `updated_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `card` SET `created_at` = unixepoch(), `updated_at` = unixepoch();
