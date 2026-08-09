ALTER TABLE `working_copy` RENAME TO `taskspace`;--> statement-breakpoint
ALTER TABLE `card` RENAME COLUMN `working_copy_id` TO `taskspace_id`;
