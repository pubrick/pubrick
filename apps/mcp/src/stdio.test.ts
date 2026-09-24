import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const id = "90ebcfc4-e20a-4b03-8501-0e883767a137";
const brandId = "0d139af6-c7a0-46f8-bfb7-b4111d8c3121";
const key = "pbrk_stdio_test_key";
const summary = {
  id,
  brandId,
  title: "A title",
  status: "draft",
  origin: "human",
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

const children = new Set<ReturnType<typeof spawn>>();
afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
});

describe("stdio MCP entry", () => {
  it("fails closed without a key and writes no non-protocol stdout", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PUBRICK_API_BASE_URL: "https://pubrick.example",
    };
    delete env.PUBRICK_API_KEY;
    const child = spawn(process.execPath, ["dist/cli.js"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [exitCode] = (await once(child, "exit")) as [number | null];
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("PUBRICK_API_KEY is required");
  });

  it("negotiates MCP and exposes exactly two read tools backed by the Bearer API", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      authorization: string | undefined;
    }> = [];
    const api = createServer((req, res) => {
      requests.push({
        url: req.url ?? "",
        method: req.method,
        authorization: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith(`/api/v1/content/${id}`)) {
        res.end(JSON.stringify({ ...summary, body: "Post body", editorialNote: "private" }));
      } else {
        res.setHeader("x-next-cursor", "next+page");
        res.end(JSON.stringify([{ ...summary, internalNote: "private" }]));
      }
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    try {
      const address = api.address();
      if (!address || typeof address === "string") throw new Error("Missing API test port");
      const child = spawn(process.execPath, ["dist/cli.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PUBRICK_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          PUBRICK_API_KEY: key,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const input = child.stdin;
      const stdout = child.stdout;
      if (!input || !stdout) throw new Error("Missing MCP test pipes");
      const pending = new Map<number, (value: Record<string, unknown>) => void>();
      const unexpectedLines: string[] = [];
      const output = createInterface({ input: stdout });
      output.on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          unexpectedLines.push(line);
          return;
        }
        if (typeof message.id === "number") pending.get(message.id)?.(message);
      });
      function call(idNumber: number, method: string, params?: unknown) {
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(idNumber);
            reject(new Error(`No MCP response for ${method}`));
          }, 5000);
          pending.set(idNumber, (message) => {
            clearTimeout(timer);
            pending.delete(idNumber);
            resolve(message);
          });
          input.write(`${JSON.stringify({ jsonrpc: "2.0", id: idNumber, method, params })}\n`);
        });
      }

      const initialized = await call(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pubrick-mcp-test", version: "1" },
      });
      expect(initialized.result).toMatchObject({ serverInfo: { name: "pubrick" } });
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

      const listed = await call(2, "tools/list");
      const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((tool) => tool.name)).toEqual(["list_content", "get_content"]);

      const page = await call(3, "tools/call", {
        name: "list_content",
        arguments: { status: "draft", limit: 1 },
      });
      const pageText = (page.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(JSON.parse(pageText)).toEqual({ items: [summary], nextCursor: "next+page" });
      expect(pageText).not.toContain("internalNote");

      const detail = await call(4, "tools/call", { name: "get_content", arguments: { id } });
      const detailText =
        (detail.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(JSON.parse(detailText)).toEqual({ ...summary, body: "Post body" });
      expect(detailText).not.toContain("editorialNote");

      expect(requests).toEqual([
        {
          url: "/api/v1/content?status=draft&limit=1",
          method: "GET",
          authorization: `Bearer ${key}`,
        },
        { url: `/api/v1/content/${id}`, method: "GET", authorization: `Bearer ${key}` },
      ]);
      expect(unexpectedLines).toEqual([]);
      input.end();
      const [exitCode] = (await once(child, "exit")) as [number | null];
      expect(exitCode).toBe(0);
    } finally {
      api.close();
    }
  });
});
