CREATE TABLE `provider_threads` (
	`conversation_id` text NOT NULL,
	`provider` text NOT NULL,
	`thread_id` text NOT NULL,
	`toolset` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`wanted_families` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_threads_conv_provider_idx` ON `provider_threads` (`conversation_id`,`provider`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `provider` text DEFAULT 'openai_api' NOT NULL;