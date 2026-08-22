CREATE INDEX `card_bundle` ON `card` (`bundle_id`);--> statement-breakpoint
CREATE INDEX `card_layer` ON `card` (`layer_id`);--> statement-breakpoint
CREATE INDEX `scope_rel_card` ON `scope_rel` (`card_id`);