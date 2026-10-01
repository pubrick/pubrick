# Release image packaging checks

This record covers local release tooling and dependency manifests. It does not
establish a published release, image runtime acceptance or hosted payment readiness.

## Downloaded assets

Source `894fd9184b008032d482909fc1a835d1af3ce375` adds the offline operator
validator documented in [releases](../releases.md). The validator compares the
downloaded manifest and three image assignments with explicit expected version,
repository and source identities. It does not contact GHCR or evaluate shell
assignments. The actual CLI is exercised in subprocesses, including sanitized
failure output.

The affected release tier passed 20 tests. Independent review found nested
platform arrays could pass through string coercion; the fix requires string
elements and the final tier includes its regression. Global Biome checked
1,119 files; the affected files passed again after the correction.

## Install manifest closure

API and web Dockerfiles copied non-target application manifests before an
unfiltered workspace installation without copying all of their workspace
dependency manifests. The previous guard checked only the build target's
closure. The expanded guard reproduced two failures: API lacked search; web
lacked Telegram (and also search). The Dockerfiles now include these manifests.

Independent read-only review confirmed the current workspace closure and the
fix. The gate follows dependency/devDependency references and the repository's
explicit COPY pattern; it is not a general Dockerfile parser. The combined
asset/Compose/manifest tier passed 23 tests, with the separate opt-in Docker
context test skipped. That skip is not container evidence.

## Remaining acceptance

Actual ARM64 Docker image construction and disposable image-backed installation
are tracked separately. The first build attempt from the working directory was
canceled during context transfer before application compilation. A retry uses
a clean archive of `894fd918`; neither result proves a successful image build.
Full image construction and runtime checks must use the corrected source before
release acceptance. AMD64 execution, anonymous registry pulls, versioned image
publication and real payment sandbox verification remain unverified.

Read-only GitHub inspection found no releases on 2026-10-02. Local operator
configuration inspection found billing and SMTP fields unconfigured; only field
presence booleans were reported, never secret values. Main integration and
publication need explicit owner authorization.
