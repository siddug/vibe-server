-- Add approval_mode column to sessions table
-- 'manual' requires user approval for tool calls
-- 'auto' auto-approves all tool calls
ALTER TABLE `sessions` ADD COLUMN `approval_mode` text DEFAULT 'manual' NOT NULL;
