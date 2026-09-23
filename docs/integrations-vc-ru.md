# VC.ru manual publishing

Pubrick prepares and reviews a VC.ru article, but a person publishes it in the
VC.ru editor. The old Content Factory called an undocumented Osnova endpoint at
`api.vc.ru/v2.8/entry/create`. Pubrick does not call that endpoint: the former
[Osnova API documentation](https://cmtt-ru.github.io/osnova-api/swaggerui/index.html)
describes an older API version, and its [source repository](https://github.com/cmtt-ru/osnova-api)
is no longer available. VC.ru's current [help page](https://vc.ru/support)
describes writing and publishing through its editor.

## Workflow

1. Add a **VC.ru** channel to a brand. It uses no token and has no connection test.
2. Create or generate a post for that channel. Review and edit its title and
   body as usual. The human involvement gate also applies to AI drafts.
3. Choose **Approve and prepare**. The adaptation moves to **Ready for manual
   publishing**. Pubrick creates no publish job and makes no VC.ru API request.
4. Copy the reviewed title and body from the post's Results section. Open
   VC.ru, publish the article there, and copy its public article URL.
5. Paste the HTTPS `vc.ru` URL into Pubrick and choose **Record publication**.
   Pubrick stores the link, the confirming member, and the confirmation time.
   This is a self-reported publication, not verification by VC.ru.

Scheduling VC.ru from Pubrick is unavailable because Pubrick cannot schedule
publication in the VC.ru editor. A mixed post with automatic and VC.ru
channels can be approved immediately: automatic channels are queued and the
VC.ru channel becomes ready for a person. Rejecting a ready manual adaptation
returns it to pending so its reviewed text can be edited again.

The confirmation endpoint is
`POST /api/content/:id/adaptations/:adaptationId/manual-publication` with
`{"url":"https://vc.ru/..."}`. It requires an authenticated organization
member and a VC.ru adaptation in `manual_ready`. Only HTTPS URLs on the exact
`vc.ru` host with a non-root path are accepted. The endpoint does not fetch the
URL or claim to authenticate its contents. Repeated confirmation is refused.
