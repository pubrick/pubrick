import { createDb } from "@pubrick/db";
import { env } from "./env";

// Single shared pool for the whole api process (auth adapter + repositories).
export const { db, pool } = createDb(env.DATABASE_URL);
