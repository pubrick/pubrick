# Covered-brand deletion fixture

CI run `36829411125` failed the media library test that expected a covered
brand's JPEG to disappear immediately after the HTTP deletion response. The
production deletion transaction stages durable cleanup before cascading the
brand, post, and media metadata; the worker removes the retained file later.

The fixture now confirms the cover is attached and its file exists before
deletion, then requires all three domain rows to be absent. Exactly one cleanup
proof must survive with the original asset ID, organization, kind, and byte
size, in pending state with no worker attempt, lease, error, or completion. The
physical JPEG must still match its original bytes until worker cleanup.

Existing eventual removal coverage is in
`apps/worker/src/media-cleanup/media-cleanup.repository.e2e.spec.ts`,
"survives organization cascade and cleans image/video files through the real
worker": it stages cleanup, invokes the real service tick, and requires both a
completed proof and `ENOENT` for image and video files. That coverage and the
production cleanup behavior are unchanged.

Verification used this branch's own installed dependencies and a disposable
pgvector/PostgreSQL 16 container bound only to `127.0.0.1:31472`. No environment
file or paid provider was used; the media fixture overrides the image caller.

- Red at base `01f82f7e2bdfa638689ecd43dd5bc05e3fe571c5`: the original covered
  brand test failed because `readFile` resolved with JPEG bytes instead of
  rejecting with `ENOENT` (one selected failure, 19 filtered tests, 12.57 seconds).
- Green: the entire native `src/media/media.e2e.spec.ts` passed all 20 tests
  without skips in 12.72 seconds.
- `pnpm --filter @pubrick/api typecheck` passed.
- Focused Biome check passed. Only the fixture and this verification note change.

The disposable database container was removed after verification. This focused
run does not claim a full repository suite result or a production deployment.
