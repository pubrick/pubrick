-- Old content may have lost its only link to a publication when a channel was
-- deleted before this migration. Such rows cannot be proven safe to delete.
-- PostgreSQL's constant DEFAULT fills them without rewriting the table.
ALTER TABLE "content_items" ADD COLUMN "is_safe_to_delete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Only content created after the durable marker and triggers are installed is
-- eligible. The migration runs as one transaction under the migration lock.
ALTER TABLE "content_items" ALTER COLUMN "is_safe_to_delete" SET DEFAULT true;--> statement-breakpoint

-- No future caller may turn a witnessed delivery (or an uncertain historical
-- row) back into a deletion-eligible draft by writing the flag directly.
CREATE FUNCTION pubrick_keep_content_deletion_safety() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.is_safe_to_delete AND NEW.is_safe_to_delete THEN
    RAISE EXCEPTION 'content deletion safety cannot be restored'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER content_items_deletion_safety_monotonic
  BEFORE UPDATE OF is_safe_to_delete ON content_items
  FOR EACH ROW EXECUTE FUNCTION pubrick_keep_content_deletion_safety();--> statement-breakpoint

-- Adaptations cascade away when their channel is deleted, after which a
-- receipt's adaptation_id becomes NULL. Remember delivery history while the
-- adaptation still carries the item link. This catches attempts without a
-- retained receipt and also direct publication rows with attempt_count = 0.
-- Live adaptations and receipts are checked by the API while their adaptation
-- locks are held. An INSERT trigger on publications would write the parent
-- during delivery and could deadlock two workers that hold parent FOR SHARE;
-- only the last moment before the adaptation link disappears needs this stamp.
CREATE FUNCTION pubrick_mark_content_with_deleted_delivery() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.attempt_count > 0
     OR OLD.status IN ('publishing', 'published', 'failed')
     OR EXISTS (SELECT 1 FROM publications WHERE adaptation_id = OLD.id)
  THEN
    UPDATE content_items
       SET is_safe_to_delete = false
     WHERE id = OLD.content_item_id
       AND org_id = OLD.org_id
       AND is_safe_to_delete;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER adaptations_preserve_delivery_deletion_history
  BEFORE DELETE ON adaptations
  FOR EACH ROW EXECUTE FUNCTION pubrick_mark_content_with_deleted_delivery();
