# First public beta — release-note candidate

**Unpublished release-note candidate.** No version or image digest has been assigned. This note
becomes a release announcement only after the selected source, both image
architectures, installation and recovery have been verified and publication
has been authorized. It does not announce a paid hosted service.

Pubrick brings the content workflow into an independent AGPL-3.0 project:
automate source collection, create content by your brand rules, and plan and
review its delivery.
It supports individual creators and teams sharing a workspace.

## What you can do

- Set up brands with a voice, audience and content language. Collect feeds and
  monitored Telegram sources, review suggested topics, and retrieve context
  from a brand's knowledge base.
- Generate and refine drafts using your own Google, OpenRouter, OpenAI,
  Anthropic or DeepSeek credentials. Vertex and public OpenAI-compatible
  endpoints have explicit credential modes and capability limits.
- Edit the master text and channel adaptations, inspect revision history,
  request client review, and approve content before delivery. Autopilot prepares
  drafts for review; it does not silently approve publication.
- Plan approved topics, recurring editorial schedules and manual evergreen
  reuse. The calendar supports reviewed bulk planning and reservations.
- Manage uploaded images and video, and opt into Gemini image generation.
  Publish through supported native channels or use the explicitly marked
  manual handoff for other platforms.
- Work in English, Spanish, Russian or Portuguese. Workspace roles, brand
  access and invitations control who can create, edit and approve content.
- Inspect usage and known/unknown model costs, export workspace data, and
  connect scoped read/write API or MCP clients without sharing an owner's key.

The public website introduces the product, use cases, open-source project,
self-hosting, hosted development and documentation. It includes a prewritten,
editable example that stays in the visitor's browser.

## Install or upgrade

Use the [self-hosting guide](../self-hosting.md). Until this candidate has
published images, install from source with Docker Compose; there is no release
image set to download yet. Configure your own auth/encryption secrets and public
origin, then add provider keys in Settings.

For an upgrade, first back up the database, media and encryption-key ring
[together](../backup-restore.md). Stop the old worker before applying migrations
through the new API, then start the matching services. Keep the previous
snapshot: an older image alone is not a database rollback.

When versioned images are available, follow the [digest-pinned release procedure](../releases.md).
Private installations remain non-indexable by default; public-site indexing
requires an explicit HTTPS origin and [configuration](../public-website.md).

## Beta limits

- This project uses BYOK. It does not include funded AI credits. Text-provider
  support does not imply support for every model, image or embedding feature;
  see the [provider matrix](../llm-providers.md).
- A manual platform workflow requires the user to complete delivery. It is not
  a native publishing integration. See [publication operations](../publication-operations.md).
- Paid hosting is not open. Hosted identity, subscriptions and quotas are
  development capabilities; payment acceptance and operating policies remain
  launch requirements. Payment verification is currently deferred.
- Optional Telegram draft-rejection controls still need a controlled live bot
  sandbox check. Use the web review flow for verified editorial decisions.
- Production capacity, provider availability, SEO results and commercial
  support commitments have not been established by local tests.

## Help and contribute

Read [CONTRIBUTING](../../CONTRIBUTING.md), report reproducible bugs through
[GitHub issues](https://github.com/pubrick/pubrick/issues), and use the private
[security reporting policy](../../SECURITY.md) for vulnerabilities. Do not attach
API keys, proxy passwords, personal data or unredacted server configuration.
