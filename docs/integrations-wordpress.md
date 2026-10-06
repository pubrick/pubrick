# Self-hosted WordPress

Pubrick's WordPress connector publishes the saved title and channel text to a
public HTTPS WordPress installation. This is a text-only connector: attached
images, video and rich article formatting are not supported. WordPress.com uses
a separate API and OAuth flow and is not covered by this connection.

## Connect a site

In **Brands → Channels → Add**, select **WordPress** and provide:

- **Site URL**: the installation URL, including its subdirectory if applicable,
  such as `https://example.com/journal/`. Do not use a post URL or the REST API URL.
- **Username**: the WordPress account that will publish the posts.
- **Application password**: create one in that account's WordPress profile.
  Use an application password rather than the account's sign-in password.

Application passwords are built into WordPress 5.6 and later; hosting policy or
plugins may disable them or the REST API. The account must have `publish_posts`
capability. A read-only **Test** checks the authenticated account and that
permission without creating a post. Saving credentials does not establish a
successful connection test.

The saved destination is displayed beside the channel. Credentials are encrypted
and are never returned to the browser. To rotate an application password, use
**Edit** and supply all connection fields. Equivalent URL spellings are
canonicalized. Changing the host, port or installation path requires a new
channel; it cannot redirect previously reviewed scheduled posts. A password
rotation preserves existing delivery times, jobs and history and resets the
connection check.

## Publish reviewed content

Write or generate content, edit the WordPress version and save it. Pubrick sends
that saved version and the saved title after human approval. Plain text is
escaped and converted into HTML paragraphs; markup entered as text is not
executed. Scheduling happens in Pubrick: the worker creates the WordPress post
when its approved delivery is due.

The connector requests `status: publish`. Only a confirmed returned `publish`
state is recorded as published. A returned `draft`, `pending` or `future` record
is retained as an uncertain outcome, including the known remote ID and safe
same-site URL. Pubrick does not automatically create another copy. Inspect the
record in WordPress and use the delivery reconciliation action. A timeout or
lost create response may also require inspection; absence from the public feed
alone does not establish that no record was created.

## Connection troubleshooting

The site must resolve to a public address and be reachable by the Pubrick server
over HTTPS. Local/private destinations and authenticated redirects are refused.
Use the final canonical installation URL when a site redirects. Check that
WordPress receives the Authorization header through its hosting proxy and that
the account can publish posts. Network failures are distinct from a rejected
application password or missing publishing permission.

Automated acceptance uses owned HTTP fixtures and disposable database records.
Live provider acceptance additionally requires a real HTTPS WordPress test site
and application password; no such account is bundled with Pubrick.

References: [WordPress REST authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/),
[posts](https://developer.wordpress.org/rest-api/reference/posts/),
[users and capabilities](https://developer.wordpress.org/rest-api/reference/users/).
