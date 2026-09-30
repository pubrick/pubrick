# Security policy

## Supported versions

Pubrick is preparing its first versioned release. Security fixes currently land
on `main`; deploy a reviewed revision and follow the upgrade guidance in
[Self-hosting](docs/self-hosting.md). A feature branch is not a supported release.
Once releases are published, supported versions and upgrade requirements will
be documented in the release notes. Do not assume older revisions receive
backported fixes.

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting form](https://github.com/pubrick/pubrick/security/advisories/new).
Private reporting is enabled for this repository. Do not put exploitable details,
customer data, credentials, or database dumps in public issues or pull requests.

Include:

- The affected source revision or release, installation mode, and component.
- Steps to reproduce with synthetic accounts and data, expected behavior, and
  observed behavior.
- The permissions needed, tenant boundaries affected, and potential impact.
- A minimal proof of concept and any suggested mitigation, with secrets removed.

Maintainers will coordinate investigation and disclosure through the private
advisory. This community project does not promise a response deadline or offer
a bug bounty. Ordinary usability problems belong in
[public issues](https://github.com/pubrick/pubrick/issues).

## Operate an instance safely

- Generate installation secrets; never deploy the example values.
- Use HTTPS on public installations and configure `PUBLIC_ORIGIN` and trusted
  proxies to match the actual deployment.
- Keep API and PostgreSQL debug ports private. Restrict access to the host,
  backups, and encryption key ring as carefully as to the database.
- Configure registration deliberately. The default first-account bootstrap is
  described in [Self-hosting](docs/self-hosting.md#who-can-register).
- Review generated content before delivery and grant workspace roles only to
  people who need them. Human approval does not validate factual claims.
- If a credential leaks, revoke it at the upstream provider and replace it in
  Pubrick. Adding a new encryption key alone does not revoke a leaked provider
  key or protect data already decrypted by an attacker.

Report a suspected product vulnerability privately before sharing logs publicly.
For an incident on your own host, preserve evidence, restrict access, and rotate
compromised credentials; follow the documented key-ring upgrade requirements so
stored credentials remain recoverable.
