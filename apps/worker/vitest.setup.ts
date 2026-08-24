// publish.service.spec.ts is a pure-mock unit test (repo/publisher are both
// vi.fn() stubs) but statically imports publish.service -> publish.repository
// -> ../db, which validates env and constructs a pg.Pool at module load. The
// Pool never actually connects until a query runs, so a syntactically valid
// placeholder is enough here — these tests never touch a real database. Uses
// ??= so a real TEST_DATABASE_URL/APP_ENCRYPTION_KEY (e.g. a future DB-backed
// worker test, mirroring apps/api's *.e2e.spec.ts pattern) still wins.
process.env.DATABASE_URL ??= "postgres://worker-test:worker-test@localhost:5432/worker-test";
process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
