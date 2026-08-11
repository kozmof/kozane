CREATE TABLE `layer` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `layer_one_default_per_project` ON `layer` (`project_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `layer_name_per_project` ON `layer` (`project_id`,`name`);--> statement-breakpoint
/* Give every existing project a default `Base` layer. SQLite has no uuid function, so
   the ids use the standard randomblob UUIDv4 expression instead of the uuidv7 the
   application generates. */
INSERT INTO `layer` (`id`, `project_id`, `name`, `position`, `is_default`) SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), `id`, 'Base', 0, 1 FROM `project`;--> statement-breakpoint
ALTER TABLE `card` ADD `layer_id` text;--> statement-breakpoint
UPDATE `card` SET `layer_id` = (SELECT `layer`.`id` FROM `layer` INNER JOIN `bundle` ON `bundle`.`project_id` = `layer`.`project_id` WHERE `bundle`.`id` = `card`.`bundle_id` AND `layer`.`is_default` = 1);--> statement-breakpoint
/* Rebuild `card` to enforce NOT NULL on the column backfilled above: SQLite cannot add a
   NOT NULL column with a REFERENCES clause in place. Migrations run under
   PRAGMA foreign_keys=off, so dropping the old table does not cascade glue_rel and
   scope_rel rows away. */
CREATE TABLE `__new_card` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`layer_id` text NOT NULL,
	`taskspace_id` text,
	`content` text NOT NULL,
	`pos_x` integer DEFAULT 0 NOT NULL,
	`pos_y` integer DEFAULT 0 NOT NULL,
	`z_index` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundle`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`layer_id`) REFERENCES `layer`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`taskspace_id`) REFERENCES `taskspace`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_card`(`id`, `bundle_id`, `layer_id`, `taskspace_id`, `content`, `pos_x`, `pos_y`, `z_index`) SELECT `id`, `bundle_id`, `layer_id`, `taskspace_id`, `content`, `pos_x`, `pos_y`, `z_index` FROM `card`;--> statement-breakpoint
DROP TABLE `card`;--> statement-breakpoint
ALTER TABLE `__new_card` RENAME TO `card`;
