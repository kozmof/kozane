ALTER TABLE `project` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `project` SET `is_default` = true WHERE `id` = (SELECT `id` FROM `project` ORDER BY `id` LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX `project_one_default` ON `project` (`is_default`) WHERE is_default = 1;