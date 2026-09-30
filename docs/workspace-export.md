# Workspace data export

Workspace owners and administrators can download a portable archive from
**Settings → Workspace data → Export**. This action remains available independently
of subscription status. Members without a management role cannot export the
workspace. The API rechecks membership against the database.

The `.tar.gz` archive contains:

- Workspace identity and membership roles.
- Explicitly allowlisted tenant records, including content, revisions, brands,
  channels, knowledge documents, monitoring sources and user settings.
- Original retained image/video files, with individual SHA-256 checksums.
- A manifest recording the snapshot time, record counts, excluded fields and
  deliberately omitted operational tables.

Credentials, invitation tokens, share tokens, private peer details, authentication
records and encrypted secrets are excluded. Derived embeddings and internal job
leases are excluded. The archive still contains private workspace content: keep
it in private storage and share it deliberately.

## Download behavior

Pubrick captures records from a consistent read-only PostgreSQL snapshot. It
creates the compressed archive in a private temporary directory, commits the
snapshot, then starts the download. Slow downloads do not hold a database
transaction. Missing/replaced media or an unsuccessful snapshot abort preparation;
no apparently successful archive is returned.

Archive preparation has a five-minute deadline. Delivery has a 45-minute deadline.
Each API process admits at most two exports, with a separate two-connection pool
and a five-second connection timeout. Preparation additionally prevents concurrent
exports of the same workspace across processes. A busy export can be retried.
Temporary compressed archives have a fixed 1 GiB technical limit. Oversized
exports fail before download with HTTP 413. Native filesystem checks preserve
256 MiB of temporary-storage headroom, checked before the first compressed chunk
and after each additional 64 MiB; insufficient space fails preparation with a
retryable HTTP 503. These checks are best effort against unrelated disk users.
Allow space for two concurrent archives and the reserved headroom per API process.

Stages use private mode 700 directories and mode 600 files. Successful, failed
and disconnected requests remove their stages in a final cleanup. An abrupt
process/host crash can leave private `pubrick-workspace-export-*` directories in
the system temporary directory. Startup and hourly maintenance remove only
matching non-symlink directories owned by the API's effective user, with mode
700 and filesystem timestamps older than two hours. Younger stages and unrelated
temporary paths are preserved. The two-hour threshold exceeds the full
five-minute preparation plus 45-minute transfer lifetime. Retention cleanup
errors are retried on the next maintenance pass; operators should investigate
temporary-storage permission or capacity errors. Before API restart, crash
artifacts remain private on disk and are not public download URLs.

The download opens separately so the settings page remains available. A failed
request can be retried from Settings; it never changes workspace data.

## Portability limits

This is a user data export, not an installation backup or a supported one-click
import. JSON records use NDJSON parts with a versioned manifest. Provider
connections must be recreated, and derived indexes rebuilt. For complete
installation recovery, including credentials and queues, use the documented
[backup and restore procedure](self-hosting.md).
