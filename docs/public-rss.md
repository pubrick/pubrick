# Public RSS syndication

Pubrick can serve a brand's selected posts as a public RSS 2.0 feed. This is a
syndication feature, not a Dzen publisher: adding an item confirms only that
Pubrick serves it in the feed. Pubrick does not call Dzen and cannot observe
whether Dzen accepted, imported, rejected, or removed it.

## Use it

1. Publish a titled post through one of Pubrick's connected channels.
2. Open the brand page and enable **Public RSS feed**. The feed starts empty.
3. Open the published post and choose **Add** in its RSS card. Confirm the
   public sharing prompt. Pubrick stores a snapshot of the title and body;
   later edits to the post do not change that public snapshot.
4. Copy the feed URL from the brand page. It and each article link are public.
   Set `PUBLIC_ORIGIN` to the reachable HTTPS origin in a self-hosted deployment
   before sharing the URL. Local `localhost` URLs are only useful on your own
   machine.
5. Remove a post from its card, or disable the whole feed on the brand page, to
   revoke its Pubrick links. Disabling also removes all entries and rotates the
   URL when the feed is enabled again. External consumers may retain copies.

The feed contains at most the 50 newest explicitly included entries. A removed
or deleted post is no longer served. An anonymous reader needs both the
organization ID and the unguessable token in the URL; neither an org ID alone
nor a post ID alone exposes content. The feed and article endpoints send
`Cache-Control: no-store` so Pubrick does not intentionally keep a stale public
copy after revocation.

## Dzen

If Dzen currently offers RSS import to your account, configure this public URL
in Dzen's own interface and check its requirements there. Feed availability,
domain verification, and ingestion behavior are controlled by Dzen and may
change. Do not treat a Pubrick feed entry as a Dzen publication receipt; check
the Dzen account itself for the outcome. The old private Content Factory
adapter marked an RSS entry as a successful Dzen post without a Dzen response.
Pubrick deliberately does not carry that behavior over.

## API

Authenticated members with an active organization can use:

| Route | Meaning |
| --- | --- |
| `GET /api/brands/:brandId/feed` | Feed state, URL, entry list |
| `POST /api/brands/:brandId/feed` | Enable an empty feed, idempotently |
| `DELETE /api/brands/:brandId/feed` | Revoke URL and entries |
| `POST /api/brands/:brandId/feed/items/:itemId` | Add a snapshot of a titled published post |
| `DELETE /api/brands/:brandId/feed/items/:itemId` | Remove its snapshot |

The returned URL and its article links are intentionally anonymous. No channel
credentials or draft content are exposed by these endpoints.
