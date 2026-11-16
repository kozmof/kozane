CREATE TABLE `local_asset_manifest` (
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`manifest` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`verified_at` integer,
	`released_at` integer,
	`release_reason` text,
	PRIMARY KEY(`owner_kind`, `owner_id`),
	CONSTRAINT "local_asset_manifest_owner" CHECK("local_asset_manifest"."owner_kind" IN ('baseline','effect-set','pending-work','transfer','recovery') AND length(trim("local_asset_manifest"."owner_id")) BETWEEN 1 AND 1000 AND instr("local_asset_manifest"."owner_id",char(0))=0),
	CONSTRAINT "local_asset_manifest_json" CHECK(json_valid("local_asset_manifest"."manifest")),
	CONSTRAINT "local_asset_manifest_state" CHECK(("local_asset_manifest"."state"='pending' AND "local_asset_manifest"."verified_at" IS NULL AND "local_asset_manifest"."released_at" IS NULL AND "local_asset_manifest"."release_reason" IS NULL) OR ("local_asset_manifest"."state"='retained' AND "local_asset_manifest"."verified_at" IS NOT NULL AND "local_asset_manifest"."released_at" IS NULL AND "local_asset_manifest"."release_reason" IS NULL) OR ("local_asset_manifest"."state"='released' AND "local_asset_manifest"."released_at" IS NOT NULL AND "local_asset_manifest"."release_reason" IS NOT NULL AND length(trim("local_asset_manifest"."release_reason")) > 0))
);
--> statement-breakpoint
CREATE INDEX `local_asset_manifest_state` ON `local_asset_manifest` (`state`);