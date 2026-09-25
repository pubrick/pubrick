# Brand access

An organization owner or admin can open **Brand access** from a brand's page
and choose which authors, editors, and regular members may work with that
brand. Owners and admins always have access. New teammates have no brand access
until assigned.
Brand-scoped lists and direct resource URLs enforce the same grants; a hidden
brand or resource returns 404. Authors can prepare drafts and generation runs;
editors can also approve, schedule, and publish. Organization-wide settings and
credentials remain owner/admin operations.

## Upgrading an existing installation

Migration 0063 grants every **existing regular member** access to every
existing brand in their organization. This preserves the access they had before
the feature. Review each brand after upgrading and remove grants that are no
longer appropriate. Existing owners and admins get no stored grants because
their roles already provide access. Changing a member's organization role
clears that person's explicit grants. In particular, a demoted admin needs new
brand assignments before using brand-scoped features.

The migration creates composite indexes and backfills one grant per existing
member–brand pair in one transaction. During that transaction, writes to the
`member` and `brands` tables can wait for index creation and backfill to finish.
For a large installation, estimate the number of grants before upgrading:

```sql
SELECT coalesce(sum(m.member_count * b.brand_count), 0) AS expected_grants
FROM (
  SELECT organization_id, count(*) AS member_count
  FROM member WHERE role = 'member' GROUP BY organization_id
) AS m
JOIN (
  SELECT org_id, count(*) AS brand_count
  FROM brands GROUP BY org_id
) AS b ON b.org_id = m.organization_id;
```

Schedule the upgrade when write traffic is low, allow the migration to finish
before starting additional API replicas, and keep a database backup. The API
applies migrations at startup; it does not serve requests before they finish.

Organization API keys are separate bearer capabilities. A key with a content
read scope can read the organization's content regardless of an individual
member's brand grants. Removing a member's grant does not revoke a key they
already possess. Owners and admins should revoke a shared key separately when
that access must end.
