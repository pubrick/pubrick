CREATE UNIQUE INDEX "member_organization_id_id_idx" ON "member" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_org_id_id_idx" ON "brands" USING btree ("org_id","id");--> statement-breakpoint
CREATE TABLE "brand_access" (
    "org_id" text NOT NULL,
    "brand_id" uuid NOT NULL,
    "member_id" text NOT NULL,
    CONSTRAINT "brand_access_brand_id_member_id_pk" PRIMARY KEY("brand_id","member_id")
);--> statement-breakpoint
ALTER TABLE "brand_access" ADD CONSTRAINT "brand_access_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_access" ADD CONSTRAINT "brand_access_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_access" ADD CONSTRAINT "brand_access_member_org_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_access_org_id_idx" ON "brand_access" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "brand_access_member_id_idx" ON "brand_access" USING btree ("member_id");--> statement-breakpoint
-- Preserve access for existing regular members. Managers have implicit access;
-- storing grants for them would grant every brand after a later demotion.
INSERT INTO "brand_access" ("org_id", "brand_id", "member_id")
SELECT b."org_id", b."id", m."id"
FROM "brands" AS b
JOIN "member" AS m ON m."organization_id" = b."org_id"
WHERE m."role" = 'member';--> statement-breakpoint
-- A role change starts with no explicit grants. In particular, a promoted
-- member must not regain stale access if later demoted by Better Auth.
CREATE FUNCTION "clear_brand_access_on_role_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."role" IS DISTINCT FROM OLD."role" THEN
    DELETE FROM "brand_access" WHERE "member_id" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "member_role_change_brand_access" AFTER UPDATE OF "role" ON "member"
FOR EACH ROW EXECUTE FUNCTION "clear_brand_access_on_role_change"();
