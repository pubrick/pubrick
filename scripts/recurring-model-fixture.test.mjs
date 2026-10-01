import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  adapterReceiptRole,
  appendReceipt,
  MODEL_URL,
  refuseNextEnvironmentFiles,
  SYNTHETIC_KEY,
  scriptedResponse,
  validateFixtureEnvironment,
} from "./e2e/recurring-model-fixture.mjs";

const marker = "weekly-browser-00000000-0000-4000-8000-000000000000";
const env = {
  PUBRICK_E2E_DISPOSABLE: "pubrick-browser-recurring-test",
  DATABASE_URL: "postgres://localhost@127.0.0.1:5432/test",
  PUBRICK_E2E_JOURNEY_MARKER: marker,
  PUBRICK_E2E_CHANNEL_CONTEXT: "/tmp/pubrick-recurring-receipts-test/channel.json",
  PUBRICK_E2E_RECEIPTS: "/tmp/pubrick-recurring-receipts-test/receipts.ndjson",
};
const request = () => ({
  url: MODEL_URL,
  method: "POST",
  headers: new Headers({ "x-goog-api-key": SYNTHETIC_KEY }),
  body: {
    systemInstruction: { parts: [{ text: "You plan a content draft before anyone writes it." }] },
    contents: [{ parts: [{ text: marker }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object", properties: { angle: { type: "string" } } },
    },
  },
});
test("fixture rejects non-disposable or external databases", () => {
  validateFixtureEnvironment(env);
  assert.throws(() =>
    validateFixtureEnvironment({ ...env, DATABASE_URL: "postgres://host.example/db" }),
  );
  assert.throws(() => validateFixtureEnvironment({ ...env, PUBRICK_E2E_DISPOSABLE: "normal" }));
});
test("structured role calls require exact transport, synthetic key and marker", () => {
  assert.equal(scriptedResponse(request(), marker).role, "researcher");
  for (const patch of [
    { url: `${MODEL_URL}?key=anything` },
    { method: "GET" },
    { headers: new Headers({ "x-goog-api-key": "real-key" }) },
    { body: { ...request().body, contents: [] } },
    { body: { ...request().body, generationConfig: {} } },
    { body: { ...request().body, systemInstruction: { parts: [{ text: "unknown" }] } } },
  ])
    assert.throws(() => scriptedResponse({ ...request(), ...patch }, marker));
});
test("caught unexpected fetch durably fails without forwarding; receipt failure exits", () => {
  const directory = mkdtempSync(join(tmpdir(), "pubrick-recurring-receipts-"));
  const receipts = join(directory, "receipts.ndjson");
  writeFileSync(receipts, "");
  const args = [
    "--import",
    new URL("./e2e/recurring-model-preload.mjs", import.meta.url).pathname,
    "--input-type=module",
    "-e",
    "try { await fetch('http://127.0.0.1:9/must-not-forward'); } catch {}",
  ];
  try {
    const result = spawnSync(process.execPath, args, {
      env: {
        PATH: process.env.PATH,
        ...env,
        PUBRICK_E2E_RECEIPTS: receipts,
        PUBRICK_E2E_CHANNEL_CONTEXT: join(directory, "channel.json"),
      },
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(receipts, "utf8")), { kind: "unexpected", marker });
    rmSync(receipts);
    const failed = spawnSync(process.execPath, args, {
      env: {
        PATH: process.env.PATH,
        ...env,
        PUBRICK_E2E_RECEIPTS: join(directory, "receipts.ndjson"),
        PUBRICK_E2E_CHANNEL_CONTEXT: join(directory, "channel.json"),
      },
      timeout: 3000,
    });
    assert.equal(failed.status, 78);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt capacity refuses before appending beyond its hard bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "pubrick-recurring-bound-test-"));
  const path = join(directory, "receipts");
  try {
    writeFileSync(path, "x".repeat(32_760));
    assert.throws(() => appendReceipt(path, { kind: "unexpected", marker }));
    assert.equal(readFileSync(path).length, 32_760);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adapter receipt names the UI-created channel and refuses mismatched context", () => {
  const context = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Weekly manual",
    platform: "t_j",
    marker,
  };
  const input = request();
  input.body.systemInstruction.parts[0].text =
    "You rewrite an approved draft for one channel: Weekly manual, on t_j.";
  assert.equal(adapterReceiptRole(input, context, marker), `adapter:${context.id}`);
  for (const patch of [
    { marker: "other" },
    { id: "not-a-channel" },
    { name: "Other" },
    { platform: "telegram" },
  ])
    assert.throws(() => adapterReceiptRole(input, { ...context, ...patch }, marker));
  input.body.systemInstruction.parts[0].text =
    "You rewrite an approved draft for one channel: Wrong, on t_j.";
  assert.throws(() => adapterReceiptRole(input, context, marker));
});

test("all five role envelopes carry the journey and valid step shapes", () => {
  const cases = [
    [
      "researcher",
      "You plan a content draft before anyone writes it.",
      ["angle", "keyPoints", "avoid"],
    ],
    ["writer", "You write the master draft, working from a brief", ["body"]],
    ["editor", "You edit a draft into the brand's voice.", ["body", "changes"]],
    ["factcheck", "You read a draft and list the factual claims", ["claims"]],
    ["adapter", "You rewrite an approved draft for one channel: Weekly manual, on t_j.", ["body"]],
  ];
  for (const [role, instruction, keys] of cases) {
    const input = request();
    input.body.systemInstruction.parts[0].text = instruction;
    const result = scriptedResponse(input, marker);
    assert.equal(result.role, role);
    const output = JSON.parse(result.response.candidates[0].content.parts[0].text);
    assert.deepEqual(Object.keys(output).sort(), keys.sort());
    assert.equal(result.response.usageMetadata.promptTokenCount, 10);
    if (role !== "factcheck") assert.ok(JSON.stringify(output).includes(marker));
  }
});

test("Next environment preflight refuses every actual loader filename without reading secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "pubrick-recurring-env-test-"));
  const project = join(directory, "web");
  const runtime = join(directory, "standalone");
  mkdirSync(project);
  mkdirSync(runtime);
  try {
    writeFileSync(join(project, ".env.example"), "safe template");
    refuseNextEnvironmentFiles(project, runtime);
    for (const location of [project, runtime])
      for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
        symlinkSync(join(directory, "missing-secret"), join(location, name));
        assert.throws(() => refuseNextEnvironmentFiles(project, runtime), /refuses/);
        rmSync(join(location, name));
      }
    refuseNextEnvironmentFiles(project, runtime);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
