import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * IS THE TRANSLATOR ACTUALLY REQUIRED?
 *
 * `errorMessage`'s third argument was optional for the length of the
 * conversion, and an omitted one does not fail: it silently drops the reader to
 * the api's English sentence. That is invisible to every test written in
 * English, and invisible to a screen that never provokes a refusal — so
 * "required" has to be a fact about the compiler, not a promise in a comment.
 *
 * The obvious way to write this is a `@ts-expect-error` over a two-argument
 * call, and it is not enough on its own: `@ts-expect-error` is satisfied by ANY
 * error on the line, so a call that had become malformed for some unrelated
 * reason would keep the assertion green while the argument went back to
 * optional. This asks the compiler directly instead, and asks it three things
 * that only hold together:
 *
 *   1. the three-argument call — the CONTROL — typechecks clean, so a failure
 *      below cannot be the call itself being wrong;
 *   2. the two-argument call is rejected with TS2554, which is specifically
 *      "Expected N arguments, but got M" and not any other complaint;
 *   3. `api.ts` itself compiles clean in this program, so the whole thing is
 *      not passing on a module that failed to resolve.
 *
 * It runs the real compiler over a file that exists only in memory (nothing is
 * written into `src/`, where a stray fixture would break `pnpm typecheck` and
 * `pnpm lint`), and costs about a third of a second.
 */

// `process.cwd()` rather than `import.meta.url`: under the jsdom environment
// that URL is an http one and `fileURLToPath` refuses it. Vitest's root is this
// package, and `beforeAll` below fails loudly if that ever stops being true.
const WEB_ROOT = `${process.cwd().replace(/\/$/, "")}/`;
const API_MODULE = `${WEB_ROOT}src/lib/api.ts`;
/** A path inside `src/lib` so `./api` resolves, but no file is ever created. */
const PROBE = `${WEB_ROOT}src/lib/__error_message_arity_probe__.ts`;

const PREAMBLE = `import { type ErrorTranslator, errorMessage } from "./api";
declare const err: unknown;
declare const t: ErrorTranslator;
`;

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  baseUrl: WEB_ROOT,
  paths: { "@/*": ["./src/*"] },
};

type Diagnostic = { code: number; message: string };

/** Typechecks `PREAMBLE + body` as if it were a module in `src/lib`. */
function check(body: string): { probe: Diagnostic[]; apiModule: Diagnostic[] } {
  const source = PREAMBLE + body;
  const host = ts.createCompilerHost(OPTIONS, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === PROBE
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, ...rest);
  host.fileExists = (name) => name === PROBE || fileExists(name);
  host.readFile = (name) => (name === PROBE ? source : readFile(name));

  const program = ts.createProgram([PROBE], OPTIONS, host);
  const all = ts.getPreEmitDiagnostics(program);
  const forFile = (path: string): Diagnostic[] =>
    all
      .filter((d) => d.file?.fileName === path)
      .map((d) => ({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, " ") }));
  return { probe: forFile(PROBE), apiModule: forFile(API_MODULE) };
}

describe("errorMessage's translator argument", () => {
  beforeAll(() => {
    // A wrong root would make every compile below trivially empty of
    // diagnostics, which reads as "the call is fine" for the one case that
    // must not be.
    expect(ts.sys.fileExists(API_MODULE), `no api.ts under ${WEB_ROOT}`).toBe(true);
  });

  it("compiles api.ts cleanly, so the two verdicts below mean what they say", () => {
    // The control for the controls: a program in which `./api` or
    // `@pubrick/shared` failed to resolve would report `errorMessage` as an
    // error type, and an error type accepts any number of arguments.
    expect(check("errorMessage(err, 'fallback', t);").apiModule).toEqual([]);
  });

  it("accepts the call WITH a translator", () => {
    expect(check("errorMessage(err, 'fallback', t);").probe).toEqual([]);
  });

  it("REJECTS the same call without one, as an arity error", () => {
    const { probe } = check("errorMessage(err, 'fallback');");

    // TS2554 is "Expected N arguments, but got M" and nothing else. An optional
    // third parameter produces no diagnostic here at all.
    expect(probe.map((d) => d.code)).toEqual([2554]);
    expect(probe[0]?.message).toContain("Expected 3 arguments, but got 2");
  });
});
