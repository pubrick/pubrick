# Brand profile import

Workspace owners and admins can open **Import** on a brand profile, enter a
public HTTP(S) website URL, and explicitly accept one metered call using the
workspace's Google AI key. Pubrick fetches at most 512 KiB with `guarded-fetch`
(public-address validation and redirect checks), extracts a bounded 12,000
characters of visible page text, and asks Gemini for editable suggestions.
Website text is sent as untrusted prompt data. Prompt injection can still
affect model output, so managers must review every suggestion. The model call
has no transport or schema-repair retries.

The preview writes **no brand data**. A manager reviews and edits the name,
description, voice, audience, content language, and up to three topic ideas.
The explicit Save action updates the profile and adds selected ideas as
unapproved `idea` topics marked with AI origin in one database transaction. The brand's link policy
and website homepage setting are never changed. Retrying Save cannot duplicate
an identical imported topic title for that brand.
If another manager changes any imported profile field during review, Save
returns a conflict and requires a fresh preview.

The API reserves one `usage_ledger` row before every model dispatch. The
reservation records an unknown cost if the process dies or the provider result
cannot be metered; successful telemetry replaces it with the actual call data.
The rolling cap is three reservations per organization per hour, serialized
under the organization row lock. The UI and API both require explicit cost
consent. Failed fetches and missing keys consume no reservation.

This first import reads one public website page only. It does not crawl the
site, log in, infer social account ownership from a link, fetch social profiles,
or verify factual claims in generated suggestions. Review remains essential.
