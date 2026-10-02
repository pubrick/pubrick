# First public beta — release-note candidate

**Historical release-note candidate, superseded on 2026-10-02.** The first
public OSS beta is now
[`v0.1.0-beta.1`](https://github.com/pubrick/pubrick/releases/tag/v0.1.0-beta.1)
at source `e394ec7c6044a39f3a9e7726d58c6c85eea92099`. Use its published notes
and assets for installation and known limits. This preparation document is
retained for history and does not announce a paid hosted service.

Pubrick brings the content workflow into an independent AGPL-3.0 project:
automate source collection, create content by your brand rules, and plan and
review its delivery.
It supports individual creators and teams sharing a workspace.

## What you can do

- Set up brands with a voice, audience and content language. Collect feeds and
  monitored Telegram sources, review suggested topics, and retrieve context
  from a brand's knowledge base.
- Create and refine content using your own Google, OpenRouter, OpenAI,
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

Follow the [published release](https://github.com/pubrick/pubrick/releases/tag/v0.1.0-beta.1),
[versioned image installation](../releases.md#operator-installation) or
[self-hosting guide](../self-hosting.md). Configure your own auth/encryption
secrets and public origin, then add provider keys in Settings.

For an upgrade, first back up the database, media and encryption-key ring
[together](../backup-restore.md). Stop the old worker before applying migrations
through the new API, then start the matching services. Keep the previous
snapshot: an older image alone is not a database rollback.

Use the [digest-pinned release procedure](../releases.md) for published images.
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
