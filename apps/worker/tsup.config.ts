import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }),
  clean: true,
  // NestJS decorators need real decorator metadata — tsup/esbuild honors
  // experimentalDecorators but not emitDecoratorMetadata; the worker only
  // uses parameterless injection, which works without metadata.
});
