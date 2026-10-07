CREATE TABLE `gmail_script_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`operation` text NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gmail_script_commands_account_idx` ON `gmail_script_commands` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `gmail_script_connections` (
	`account_id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gmail_script_messages` (
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_script_messages_id_idx` ON `gmail_script_messages` (`account_id`,`message_id`);