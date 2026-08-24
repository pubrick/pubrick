import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }),
  clean: true,
  // NestJS decorators need real decorator metadata — tsup/esbuild honors
  // experimentalDecorators but not emitDecoratorMetadata; the worker only
  // uses parameterless injection, which works without metadata.
  //
  // pg-boss is ESM-only; the CJS bundle relies on Node's require(esm),
  // stable since 22.12 — matching pg-boss's own engines floor.
});
