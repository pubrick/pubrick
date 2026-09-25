# Manual publication channels

Pubrick can prepare posts for VC.ru, Dzen, Instagram, YouTube, RuTube and
TenChat. These channels have no credentials, connection test or automatic
publisher. Approving a post changes its channel adaptation to **Ready for
manual publishing** and creates no publish job. The editor must publish it on
the platform and record the resulting public URL in Pubrick.

## Workflow

1. Add a manual channel to a brand and create or generate a post for it.
2. Review and edit the title and body. The normal human involvement gate applies
   to AI drafts.
3. Choose **Approve and prepare**. Scheduled approval is unavailable for manual
   channels; mixed automatic and manual posts may be approved immediately.
4. In the post's Results section, copy the reviewed title and body together or
   separately. Open the platform and paste the material into its editor. For
   YouTube and RuTube, download an attached MP4 if present, then upload and edit
   it there yourself; Pubrick does not send video to these channels. VC.ru also
   offers a portable article and image ZIP.
5. Publish on the platform, copy the public post URL, and choose **Record
   publication** in Pubrick. Pubrick stores the URL, member and time as a
   **self-reported** receipt. It does not fetch the link or verify the post.

Rejecting a ready adaptation returns it to pending for editing. Removing a
channel removes its pending Pubrick adaptations, but cannot remove content
already published on the platform.

Pubrick's channel text counters are editorial targets for preparing a post,
not verified platform limits. Check the platform editor's current requirements
before publishing. In particular, Instagram uses a shorter local target than
the other manual channels.

The confirmation endpoint is
`POST /api/content/:id/adaptations/:adaptationId/manual-publication` with
`{"url":"https://..."}`. It requires an authenticated member with editorial
access to the adaptation, a `manual_ready` state and an HTTPS post URL on the
channel's own host with a non-root path. Allowed hosts are exact platform hosts:
`vc.ru`, `dzen.ru`, `instagram.com`, `youtube.com`/`youtu.be`, `rutube.ru`,
and `tenchat.ru` (plus the supported `www`/mobile forms). A URL for another
platform, a homepage URL, an insecure URL and repeated confirmation are
refused. The server reads the saved channel before validating its host, so a
caller cannot claim that a VC.ru adaptation was published on Dzen.

## Dzen RSS is separate

Pubrick's optional [public RSS feed](public-rss.md) serves snapshots for
syndication. A feed entry means Pubrick served it, not that Dzen imported or
published it. A Dzen manual receipt exists only after a person publishes on
Dzen and records the public Dzen URL. Pubrick does not infer a receipt from
the RSS feed.

Older installations may already have an encrypted Dzen token on a channel.
The migration preserves that ciphertext; the manual workflow does not use or
return it. New Dzen channels are created without credentials.

For VC.ru's article package and legacy API decision, see
[VC.ru manual publishing](integrations-vc-ru.md).
