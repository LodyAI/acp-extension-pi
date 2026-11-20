import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CONFIG_ENV, registerMcpTools } from "../src/mcp.js";

const listTools = vi.hoisted(() =>
  vi.fn(async () => ({
    tools: [{ name: "read", inputSchema: { type: "object" } }],
  })),
);
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn();
    close = vi.fn();
    listTools = listTools;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(public options: unknown) {}
  },
}));
const httpTransports = vi.hoisted(
  () => [] as { url: string; headers: Record<string, string> }[],
);
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: { requestInit?: RequestInit }) {
      httpTransports.push({
        url: url.toString(),
        headers: (opts?.requestInit?.headers ?? {}) as Record<string, string>,
      });
    }
  },
}));
const originalConfig = process.env[MCP_CONFIG_ENV];
let directory: string | undefined;
afterEach(() => {
  if (originalConfig === undefined) delete process.env[MCP_CONFIG_ENV];
  else process.env[MCP_CONFIG_ENV] = originalConfig;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function activation(
  servers: string[],
  active: string[],
  exposure = "direct",
  http?: {
    name: string;
    url: string;
    headers: { name: string; value: string }[];
  },
) {
  directory ??= mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
  const config = join(directory, "servers.json");
  writeFileSync(
    config,
    JSON.stringify([
      ...servers.map((name) => ({
        name,
        command: "synthetic",
        args: [],
        env: [],
      })),
      ...(http ? [{ ...http, type: "http" }] : []),
    ]),
  );
  process.env[MCP_CONFIG_ENV] = config;
  const tools: any[] = [];
  const handlers = new Map<string, Function>();
  const setActiveTools = vi.fn();
  const failure = await registerMcpTools({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.push({ ...tool, exposure }),
    getActiveTools: () => active,
    getAllTools: () => tools,
    setActiveTools,
  } as unknown as ExtensionAPI);
  if (failure) throw new Error(failure);
  handlers.get("session_start")!();
  return setActiveTools;
}

describe("ACP MCP activation loadout", () => {
  it("reports a tools/list timeout without forwarding SDK details", async () => {
    listTools.mockRejectedValueOnce(
      new McpError(ErrorCode.RequestTimeout, "private fixture detail"),
    );
    await expect(activation(["catalog"], [])).rejects.toThrow(
      /^Could not list tools from MCP server "catalog" \(request timed out\)\. Check the server configuration or deselect it and retry\.$/,
    );
  });
  it("identifies the server whose normalized tool name conflicts", async () => {
    await expect(activation(["my server", "my_server"], [])).rejects.toThrow(
      /Could not register tools from MCP server "my_server": normalized tool names must be unique/,
    );
  });
  it("adds current MCP selection absent from restored history while preserving native user tool choices", async () => {
    const update = await activation(
      ["target"],
      ["read", "user_extension_tool"],
    );
    expect(update).toHaveBeenCalledWith([
      "read",
      "user_extension_tool",
      "mcp_target_read",
    ]);
  });
  it("keeps codemode active and delegates declaration projection to native setActiveTools", async () => {
    const update = await activation(["target"], ["codemode", "read"]);
    expect(update).toHaveBeenCalledWith([
      "codemode",
      "read",
      "mcp_target_read",
    ]);
  });
  it.each(["hidden", "codemode", "deferred"])(
    "does not activate %s tools to bypass their native exposure",
    async (exposure) => {
      const update = await activation(["target"], ["codemode"], exposure);
      expect(update).toHaveBeenCalledWith(["codemode"]);
    },
  );
  it("does not add any tools for an empty selection", async () => {
    const update = await activation([], ["bash"]);
    expect(update).toHaveBeenCalledWith(["bash"]);
  });
  it("connects http servers through the streamable transport and forwards headers", async () => {
    const update = await activation([], ["read"], "direct", {
      name: "remote",
      url: "https://mcp.example.com/endpoint?token=redacted",
      headers: [
        { name: "Authorization", value: "Bearer secret" },
        { name: "X-Tenant", value: "acme" },
      ],
    });
    expect(update).toHaveBeenCalledWith(["read", "mcp_remote_read"]);
    expect(httpTransports).toEqual([
      {
        url: "https://mcp.example.com/endpoint?token=redacted",
        headers: { Authorization: "Bearer secret", "X-Tenant": "acme" },
      },
    ]);
  });
});
