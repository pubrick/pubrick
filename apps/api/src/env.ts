import { parseEnv } from "@pubrick/shared";
import { z } from "zod";

export const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(3001),
});
