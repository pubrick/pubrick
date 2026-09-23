ALTER TABLE "adaptations" DROP CONSTRAINT "adaptations_status_check";--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "credentials_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_credentials_mode_check" CHECK (("channels"."platform" = 'vc_ru') = ("channels"."credentials_encrypted" is null));--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_status_check" CHECK ("adaptations"."status" in ('pending', 'manual_ready', 'scheduled', 'queued', 'publishing', 'published', 'failed'));