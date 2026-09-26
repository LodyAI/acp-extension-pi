import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { MCP_CONFIG_ENV, registerMcpTools } from "../src/mcp.js";

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
  vi.unstubAllEnvs();
  rmSync(join(process.cwd(), "mcp-pids"), { force: true });
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("connects, lists and calls tools on modern-only and legacy stdio servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "lody-pi-mcp-"));
  roots.push(root);
  const config = join(root, "servers.json");
  writeFileSync(
    config,
    JSON.stringify([
      {
        name: "modern",
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/modern-mcp.mjs", import.meta.url)),
        ],
        env: [],
      },
      {
        name: "legacy",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/mcp.mjs", import.meta.url))],
        env: [{ name: "MCP_FIXTURE_TAG", value: "legacy" }],
      },
    ]),
  );
  vi.stubEnv(MCP_CONFIG_ENV, config);

  const tools = new Map<string, ToolDefinition>();
  const pi = {
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_shutdown") shutdowns.push(handler);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  await registerMcpTools(pi);

  expect([...tools.keys()]).toContain("mcp_modern_echo");
  expect([...tools.keys()]).toContain("mcp_legacy_echo");
  const signal = new AbortController().signal;
  const modern = await tools
    .get("mcp_modern_echo")!
    .execute("modern-call", { value: "hello" }, signal, {} as never);
  const legacy = await tools
    .get("mcp_legacy_echo")!
    .execute("legacy-call", { value: "hello" }, signal, {} as never);
  expect(modern.content).toContainEqual({ type: "text", text: "modern:hello" });
  expect(legacy.content).toContainEqual({
    type: "text",
    text: "MCP:legacy:hello",
  });
}, 20_000);
