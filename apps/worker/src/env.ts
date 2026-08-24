import { parseEnv } from "@pubrick/shared";
import { z } from "zod";

export const env = parseEnv({ DATABASE_URL: z.string().min(1) });
