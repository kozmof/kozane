-- Enforce two card invariants in the database with triggers. A CHECK constraint or a new
-- column default would require rebuilding `card`, and dropping it with foreign keys enabled
-- would cascade into its relations (see 0011 and 0015).
--
-- 1. inventory_id and inventory_slot are set or cleared together.
-- 2. Inserts that leave a timestamp at the column's DEFAULT 0 get the insert time instead
--    of the Unix epoch.
--
-- First put back on the canvas any card that already has only one column set. Readers
-- already treat such a card as on the canvas, and `kozane inventory repair` does the same.
UPDATE `card` SET `inventory_id` = NULL, `inventory_slot` = NULL
WHERE (`inventory_id` IS NULL) <> (`inventory_slot` IS NULL);
--> statement-breakpoint
CREATE TRIGGER `card_inventory_pair_insert`
BEFORE INSERT ON `card`
WHEN (NEW.`inventory_id` IS NULL) <> (NEW.`inventory_slot` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'card inventory_id and inventory_slot must be set together');
END;
--> statement-breakpoint
-- Clearing inventory_id alone is allowed and clears the slot too (the trigger below). That
-- is the path the `ON DELETE set null` foreign key action takes when an inventory row is
-- deleted outside `deleteInventory`.
CREATE TRIGGER `card_inventory_pair_update`
BEFORE UPDATE OF `inventory_id`, `inventory_slot` ON `card`
WHEN (NEW.`inventory_id` IS NULL) <> (NEW.`inventory_slot` IS NULL)
  AND NOT (NEW.`inventory_id` IS NULL AND OLD.`inventory_id` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'card inventory_id and inventory_slot must be set together');
END;
--> statement-breakpoint
CREATE TRIGGER `card_inventory_clear_slot`
AFTER UPDATE OF `inventory_id` ON `card`
WHEN NEW.`inventory_id` IS NULL AND NEW.`inventory_slot` IS NOT NULL
BEGIN
  UPDATE `card` SET `inventory_slot` = NULL WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- unixepoch() returns seconds, matching Drizzle's integer({ mode: "timestamp" }) storage. A
-- missing updated_at follows created_at, so the card does not read as edited.
CREATE TRIGGER `card_stamp_missing_timestamps`
AFTER INSERT ON `card`
WHEN NEW.`created_at` = 0 OR NEW.`updated_at` = 0
BEGIN
  UPDATE `card` SET
    `created_at` = CASE WHEN `created_at` = 0 THEN unixepoch() ELSE `created_at` END,
    `updated_at` = CASE
      WHEN `updated_at` <> 0 THEN `updated_at`
      WHEN `created_at` = 0 THEN unixepoch()
      ELSE `created_at`
    END
  WHERE `id` = NEW.`id`;
END;
