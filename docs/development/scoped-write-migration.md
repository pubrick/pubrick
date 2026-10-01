# Scoped write foundation migration maintenance

Migration 0125 widens already constrained scope/origin sets and adds the imported
review obligation. Five checks use `NOT VALID` to avoid scanning populated tables
under startup ALTER locks. They still reject invalid new writes immediately.
The existing validated constraints already prove historical scopes/origins are
subsets; historical imported-review values initialize false. New operation table
constraints are validated on creation.

After a backup and an operator-chosen maintenance window, validate individually:

```sql
ALTER TABLE organization_api_keys VALIDATE CONSTRAINT organization_api_keys_scope_check;
ALTER TABLE adaptations VALIDATE CONSTRAINT adaptations_origin_check;
ALTER TABLE content_items VALIDATE CONSTRAINT content_items_origin_check;
ALTER TABLE content_versions VALIDATE CONSTRAINT content_versions_origin_check;
ALTER TABLE content_items VALIDATE CONSTRAINT content_items_external_review_check;
```

These maintenance commands are separate from application startup. No migration
or worker records imported intake as evidence of originality or authorship.

The MIT-licensed `rate-limiter-flexible@11.2.1` is a direct API dependency. Its
maintained PostgreSQL adapter owns atomic counter consumption; Pubrick owns the
migration and bounded cleanup. The native fixture tests actual consumption and
refusal against this table rather than reproducing the adapter's SQL. Memory or
Redis fallback would make multi-process request limits unreliable and is excluded.
