import { createDb } from "@pubrick/db";
import { env } from "./env";

// Single shared pool for the whole worker process (publish repository).
export const { db, pool } = createDb(env.DATABASE_URL);
