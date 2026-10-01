-- Preserve the old physical lane while recovering through a different verified bot.
CREATE OR REPLACE FUNCTION telegram_config_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.revision < OLD.revision OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'Configuration revision cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF (NEW.bot_identity_id, NEW.generation, NEW.route_id, NEW.secret_hash, NEW.credentials_encrypted, NEW.retry_payload_encrypted)
     IS DISTINCT FROM (OLD.bot_identity_id, OLD.generation, OLD.route_id, OLD.secret_hash, OLD.credentials_encrypted, OLD.retry_payload_encrypted) THEN
    IF NEW.revision <= OLD.revision OR NEW.generation <= OLD.generation OR
       (EXISTS (SELECT 1 FROM telegram_remote_attempts WHERE bot_identity_id = OLD.bot_identity_id AND outcome IN ('attempted', 'unknown')) AND (NEW.bot_identity_id = OLD.bot_identity_id OR NOT EXISTS (SELECT 1 FROM telegram_bot_identities WHERE id = OLD.bot_identity_id AND quarantined AND NOT enabled))) THEN
      RAISE EXCEPTION 'Frozen generation cannot change with unresolved mutation' USING ERRCODE = '23514';
    END IF;
    IF NEW.bot_identity_id IS DISTINCT FROM OLD.bot_identity_id AND NOT EXISTS (SELECT 1 FROM telegram_bot_identities WHERE id = OLD.bot_identity_id AND NOT enabled) THEN
      RAISE EXCEPTION 'Disable the previous bot before replacement' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM telegram_bot_identities WHERE id = NEW.bot_identity_id AND owner_org_id = NEW.org_id AND generation = NEW.generation AND NOT quarantined AND (NEW.bot_identity_id = OLD.bot_identity_id OR (unresolved_attempts = 0 AND remote_state NOT IN ('attempted', 'unknown'))) AND (NEW.bot_identity_id = OLD.bot_identity_id OR NOT EXISTS (SELECT 1 FROM telegram_remote_attempts WHERE bot_identity_id = NEW.bot_identity_id AND outcome IN ('attempted', 'unknown')))) THEN
      RAISE EXCEPTION 'Bot generation is not owned by organization' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
