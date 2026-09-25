-- An attempt remains as a permanent money/sample claim after its source,
-- publication, or brand is deleted, but its frozen prompt must not. A queued
-- request was never dispatched and can release its reservation. A dispatching
-- request may already be billable: retain its maximum reservation as unknown.
CREATE FUNCTION paid_reply_purge_deleted_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'brands' THEN
    UPDATE paid_reply_analysis_attempts a SET
      prompt_encrypted = NULL,
      status = CASE WHEN a.status = 'queued' THEN 'canceled' WHEN a.status = 'dispatching' THEN 'unknown' ELSE a.status END,
      completed_at = CASE WHEN a.status IN ('queued', 'dispatching') THEN now() ELSE a.completed_at END,
      failure_code = CASE WHEN a.status IN ('queued', 'dispatching') THEN 'target_deleted' ELSE a.failure_code END
    WHERE a.org_id = OLD.org_id AND a.brand_id = OLD.id
      AND (a.prompt_encrypted IS NOT NULL OR a.status IN ('queued', 'dispatching'));
  ELSIF TG_TABLE_NAME = 'news_items' THEN
    UPDATE paid_reply_analysis_attempts a SET
      prompt_encrypted = NULL,
      status = CASE WHEN a.status = 'queued' THEN 'canceled' WHEN a.status = 'dispatching' THEN 'unknown' ELSE a.status END,
      completed_at = CASE WHEN a.status IN ('queued', 'dispatching') THEN now() ELSE a.completed_at END,
      failure_code = CASE WHEN a.status IN ('queued', 'dispatching') THEN 'target_deleted' ELSE a.failure_code END
    WHERE a.org_id = OLD.org_id AND a.target_kind = 'source_comment' AND a.target_id = OLD.id
      AND (a.prompt_encrypted IS NOT NULL OR a.status IN ('queued', 'dispatching'));
  ELSIF TG_TABLE_NAME = 'publications' THEN
    UPDATE paid_reply_analysis_attempts a SET
      prompt_encrypted = NULL,
      status = CASE WHEN a.status = 'queued' THEN 'canceled' WHEN a.status = 'dispatching' THEN 'unknown' ELSE a.status END,
      completed_at = CASE WHEN a.status IN ('queued', 'dispatching') THEN now() ELSE a.completed_at END,
      failure_code = CASE WHEN a.status IN ('queued', 'dispatching') THEN 'target_deleted' ELSE a.failure_code END
    WHERE a.org_id = OLD.org_id AND a.target_kind = 'publication_comment' AND a.target_id = OLD.id
      AND (a.prompt_encrypted IS NOT NULL OR a.status IN ('queued', 'dispatching'));
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paid_reply_purge_news_item AFTER DELETE ON news_items
FOR EACH ROW EXECUTE FUNCTION paid_reply_purge_deleted_target();--> statement-breakpoint
CREATE TRIGGER paid_reply_purge_publication AFTER DELETE ON publications
FOR EACH ROW EXECUTE FUNCTION paid_reply_purge_deleted_target();--> statement-breakpoint
CREATE TRIGGER paid_reply_purge_brand AFTER DELETE ON brands
FOR EACH ROW EXECUTE FUNCTION paid_reply_purge_deleted_target();
