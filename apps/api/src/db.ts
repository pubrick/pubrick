import { createDb } from "@pubrick/db";
import { env } from "./env";

// Single shared pool for the whole api process (auth adapter + repositories).
// Bound pool checkout as well as new connections; model admission cannot wait indefinitely.
export const { db, pool } = createDb(env.DATABASE_URL, { connectionTimeoutMillis: 5000 });
