CREATE TABLE `inventory` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`pos_x` integer DEFAULT 0 NOT NULL,
	`pos_y` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespace`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inventory_namespace` ON `inventory` (`namespace_id`);--> statement-breakpoint
ALTER TABLE `card` ADD `inventory_id` text REFERENCES inventory(id) ON UPDATE cascade ON DELETE set null;--> statement-breakpoint
ALTER TABLE `card` ADD `inventory_slot` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `card_inventory_slot` ON `card` (`inventory_id`,`inventory_slot`);