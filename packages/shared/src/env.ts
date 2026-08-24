import { z } from "zod";

/** Parse environment variables against a zod shape; throw with all problems at once. */
export function parseEnv<T extends z.ZodRawShape>(
  shape: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<z.ZodObject<T>> {
  const result = z.object(shape).safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return result.data;
}
