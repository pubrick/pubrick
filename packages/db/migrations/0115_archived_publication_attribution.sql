-- Replace the existing channel tombstone function. A BEFORE DELETE trigger
-- covers API deletes, cascades from brand deletion, and direct SQL deletes.
-- Brand attribution is stamped with the channel identity before FK SET NULL.
-- Existing live receipts stay NULL until deletion, avoiding a large startup
-- rewrite. Already orphaned rows cannot be attributed safely and stay NULL.
CREATE OR REPLACE FUNCTION publications_stamp_deleted_channel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE publications
     SET channel_name = COALESCE(channel_name, OLD.name),
         channel_platform = COALESCE(channel_platform, OLD.platform),
         brand_id = COALESCE(brand_id, OLD.brand_id)
   WHERE org_id = OLD.org_id AND channel_id = OLD.id;
  RETURN OLD;
END;
$$;
