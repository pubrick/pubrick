# Scoped integration: local operator upgrade

Date: 2026-10-01 (Europe/Moscow).

## Recovery preparation

The normal local Compose installation was upgraded from `0e040031`, with
124 database migrations, after the scoped implementation passed its integrated
[verification](2026-10-01-scoped-draft-writes.md).

A fresh private database, media and configuration snapshot was created outside
the checkout. Applications were quiesced for the snapshot and then restarted.
All four manifest checksums passed; the directory uses mode 700 and payloads
and manifests mode 600. Existing recovery snapshots were retained. The operator
configuration, auth secret and encryption key ring matched the new snapshot
after the upgrade. No secret values or tenant content entered this report.

## Canonical builds and cutover

All three canonical Dockerfiles built successfully with ordinary Compose cache
and no build overrides. API context was captured at `78645d44`; worker and web
contexts were captured at `ea055687`. Their only difference is documentation;
application source is identical. These are local `linux/arm64` builds, not
AMD64 verification or published source-linked release images.

Local image IDs after cutover:

| Service | Local image ID |
| --- | --- |
| API | `8d6c49d0b5b39c4ff1480d3c5de38d8b2bb99ddce3f59665a5b44fdc8e5b6eda` |
| Worker | `8cb0a1d527e0bebad1378b82c82b97976a398d5f0c01eb29c354f9ce392b61bc` |
| Web | `62d372f1e68f300edf47b2aa0e91c1da186118302e47bf1b0a9b5878bcccff87` |

Image IDs are not registry manifest digests and should not be substituted into
release deployment files.

The old worker, web and API were stopped after all images were ready. The new
API was started with `--no-deps --no-build --pull never --wait`; worker and web
were resumed only after migration, health and retained-data checks succeeded.
The existing PostgreSQL container and durable PostgreSQL/media volumes were
retained.

Observed checks:

- 125 migration journal rows, latest timestamp `1790831576501`, matching
  `0125_mean_silver_fox`.
- Existing organization, content, run, media and usage counts unchanged; no
  active generation runs before or after cutover. New operation/counter tables
  empty.
- All application containers running with zero restarts; API and PostgreSQL
  healthy. Worker and web have no configured Docker health checks.
- `/api/health`: HTTP 200. Scoped v2 GET routes: HTTP 401 without credentials.
  Compiled v2 controllers, repository and limiter present; web bundles contain
  both new write-scope controls.
- `/ru/login` and `/ru/settings`: HTTP 200, establishing unauthenticated route
  availability only. Authenticated editing is proven by the isolated built
  browser journey, not by these route probes.
- Bounded operator status command succeeded in self-hosted mode, with API, worker
  and PostgreSQL running and no unknown-media count.

No paid provider call, credential replacement or publication was performed.
The saved Google connection was previously checked separately; this upgrade
does not claim a new provider probe.

## Bounded cleanup

Only exact generated paths and attested Pubrick build-cache IDs were removed.
Four completed implementation checkouts had clean source status; dry runs
selected only their ignored `node_modules`. Their removal increased observed
free space by about 100 MiB, despite much larger logical sizes. The completed
root browser build's ignored `.next` output was also removed after its dry run;
application source and test evidence remained intact.

Exact obsolete API/worker deployment caches, nine old Pubrick builder-chain
records, and one newly completed API intermediate deployment record were
removed with individual ID filters. Exported current images, rollback images
and both durable volumes were protected throughout cutover. Concurrent builds
and filesystem sharing prevent attributing every free-space change to a
single removal. One cache-removal client timed out; read-only inspection
confirmed its target absent and the command was not retried. No broad Docker,
volume or shared dependency-store prune was used.

After final stability checks, the three obsolete runtime image IDs had zero
container references and only their owned rollback tags. Non-forced removal
deleted those exact tags/images; their IDs were subsequently absent. Current
application/PostgreSQL images, both durable volumes and private snapshots were
retained. Observed free space increased by about 126 MiB, to about 3.8 GiB.
There are no archived image payloads in the snapshots: restoring the old
installation requires rebuilding its matching old source, alongside restoring
its database/media/key snapshot.
Public image installation, commercial configuration and main release remain
separate pending requirements.
