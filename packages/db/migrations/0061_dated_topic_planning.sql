ALTER TABLE "autopilot_configs" ADD COLUMN "auto_plan_topics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "autopilot_configs" ADD COLUMN "planning_daily_limit" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "planned_date" date;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "priority" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "autopilot_configs" ADD CONSTRAINT "autopilot_configs_planning_daily_limit_check" CHECK ("autopilot_configs"."planning_daily_limit" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "autopilot_configs" ADD CONSTRAINT "autopilot_configs_auto_plan_channels_check" CHECK (NOT "autopilot_configs"."auto_plan_topics" OR jsonb_array_length("autopilot_configs"."channel_ids") > 0);--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_priority_check" CHECK ("topics"."priority" BETWEEN 1 AND 10);