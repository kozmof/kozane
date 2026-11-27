CREATE TABLE `local_image_upload` (
	`filename` text PRIMARY KEY NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`installed_at` integer,
	`completed_at` integer,
	`error` text,
	`abandoned_at` integer,
	`abandon_reason` text,
	CONSTRAINT "local_image_upload_name" CHECK(length("local_image_upload"."filename") IN (40,41) AND substr("local_image_upload"."filename",37,1)='.' AND substr("local_image_upload"."filename",1,36) NOT GLOB '*[^a-f0-9-]*' AND substr("local_image_upload"."filename",38) IN ('jpg','jpeg','png','svg')),
	CONSTRAINT "local_image_upload_bytes" CHECK(typeof("local_image_upload"."byte_length")='integer' AND "local_image_upload"."byte_length" BETWEEN 1 AND 10485760 AND length("local_image_upload"."sha256")=64 AND "local_image_upload"."sha256" NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "local_image_upload_state" CHECK(("local_image_upload"."state"='pending' AND "local_image_upload"."installed_at" IS NULL AND "local_image_upload"."completed_at" IS NULL AND "local_image_upload"."abandoned_at" IS NULL AND "local_image_upload"."abandon_reason" IS NULL) OR ("local_image_upload"."state"='installed' AND "local_image_upload"."installed_at" IS NOT NULL AND "local_image_upload"."completed_at" IS NULL AND "local_image_upload"."error" IS NULL AND "local_image_upload"."abandoned_at" IS NULL AND "local_image_upload"."abandon_reason" IS NULL) OR ("local_image_upload"."state"='completed' AND "local_image_upload"."installed_at" IS NOT NULL AND "local_image_upload"."completed_at" IS NOT NULL AND "local_image_upload"."error" IS NULL AND "local_image_upload"."abandoned_at" IS NULL AND "local_image_upload"."abandon_reason" IS NULL) OR ("local_image_upload"."state"='abandoned' AND "local_image_upload"."completed_at" IS NULL AND "local_image_upload"."abandoned_at" IS NOT NULL AND "local_image_upload"."abandon_reason" IS NOT NULL AND length(trim("local_image_upload"."abandon_reason")) > 0))
);
--> statement-breakpoint
CREATE INDEX `local_image_upload_state` ON `local_image_upload` (`state`);