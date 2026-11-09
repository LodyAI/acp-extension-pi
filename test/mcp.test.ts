import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
// Pi's own resolver and validator, which the bundled CLI applies to registered servers.
import { resolveConfigValue } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";
import { validateMcpServerConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import { MCP_SERVERS_SECTION as PI_MCP_SERVERS_SECTION } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js";
import {
  MCP_CONFIG_ENV,
  MCP_SERVERS_SECTION,
  literalConfigValue,
  registerMcp,
  toPiMcpServers,
} from "../src/mcp.js";

const stdio = (name: string, env: { name: string; value: string }[] = []) => ({
  name,
  command: "synthetic",
  args: ["--flag"],
  env,
});

describe("ACP MCP servers as Pi registrations", () => {
  it.each([
    "plain-token",
    "abc$HOME",
    "${PATH}",
    "$$",
    "$!",
    "!echo leaked",
    "!",
    "trailing$",
    "",
  ])("passes %j to the server unchanged", (value) => {
    expect(resolveConfigValue(literalConfigValue(value))).toBe(value);
  });

  it("registers every server as deferred with escaped env and headers", () => {
    const servers = toPiMcpServers([
      stdio("local", [{ name: "TOKEN", value: "!rm -rf $HOME" }]),
      {
        type: "http",
        name: "remote",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer a$b" }],
      },
    ]);
    expect(servers).toEqual([
      {
        name: "local",
        config: {
          type: "stdio",
          command: "synthetic",
          args: ["--flag"],
          env: { TOKEN: "$!rm -rf $$HOME" },
          exposure: "deferred",
        },
      },
      {
        name: "remote",
        config: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer a$$b" },
          exposure: "deferred",
        },
      },
    ]);
    for (const { name, config } of servers)
      expect(validateMcpServerConfig(name, config)).toEqual(config);
  });

  it("maps free-form Lody names to distinct Pi server namespaces", () => {
    const names = toPiMcpServers([
      stdio("My Server"),
      stdio("My_Server"),
      stdio("a-b"),
      stdio("服务"),
      stdio(""),
      stdio("solo"),
    ]).map(({ name }) => name);
    expect(names[0]).toMatch(/^My_Server_[0-9a-f]{6}$/);
    expect(names[1]).toMatch(/^My_Server_[0-9a-f]{6}$/);
    expect(names[0]).not.toBe(names[1]);
    expect(names.slice(2)).toEqual(["a-b", "__", "server", "solo"]);
    for (const name of names)
      expect(validateMcpServerConfig(name, { command: "x" })).not.toBeTypeOf(
        "string",
      );
  });

  it("keeps colliding names stable when the selection order changes", () => {
    const a = { ...stdio("dup"), command: "first" };
    const b = { ...stdio("dup"), command: "second" };
    const http = {
      type: "http" as const,
      name: "d-u-p",
      url: "https://a.example/mcp",
      headers: [],
    };
    const forward = toPiMcpServers([a, b, http]).map(({ name }) => name);
    const reverse = toPiMcpServers([http, b, a]).map(({ name }) => name);
    expect(new Set(forward).size).toBe(3);
    expect(reverse).toEqual([...forward].reverse());
    // An exact duplicate still gets a distinct namespace.
    const twins = toPiMcpServers([a, a]).map(({ name }) => name);
    expect(twins[1]).toBe(`${twins[0]}_2`);
  });

  it("names Pi's MCP prompt section", () => {
    expect(MCP_SERVERS_SECTION).toBe(PI_MCP_SERVERS_SECTION);
  });
});

describe("Pi MCP extension wiring", () => {
  let directory: string | undefined;
  const original = process.env[MCP_CONFIG_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[MCP_CONFIG_ENV];
    else process.env[MCP_CONFIG_ENV] = original;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function load(servers: unknown[]) {
    directory = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
    const config = join(directory, "servers.json");
    writeFileSync(config, JSON.stringify(servers));
    process.env[MCP_CONFIG_ENV] = config;
    const registered: { name: string; config: unknown }[] = [];
    const tools: { name: string; defaultActive?: boolean }[] = [];
    const commands: string[] = [];
    const handlers = new Map<string, Function>();
    registerMcp({
      registerMcpServer(name: string, raw: unknown) {
        const validated = validateMcpServerConfig(name, raw);
        if (typeof validated === "string") throw new Error(validated);
        registered.push({ name, config: validated });
      },
      getMcpServers: () =>
        registered.map((server) => ({ ...server, extensionPath: "lody" })),
      registerTool: (tool: { name: string }) => tools.push(tool),
      registerToolRenderer: () => {},
      registerCommand: (name: string) => commands.push(name),
      on: (name: string, handler: Function) => handlers.set(name, handler),
      getAllTools: () => tools,
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI);
    return { registered, tools, commands, handlers };
  }

  it("adds tool_search and /mcp without reading mcp.json", () => {
    const { registered, tools, commands } = load([stdio("fixture")]);
    expect(registered.map(({ name }) => name)).toEqual(["fixture"]);
    expect(tools).toContainEqual(
      expect.objectContaining({ name: "tool_search", defaultActive: false }),
    );
    expect(commands).toContain("mcp");
  });

  it("reports an invalid server once instead of failing extension load", () => {
    const { registered, handlers } = load([
      {
        type: "http",
        name: "remote",
        url: "ftp://mcp.example.com/secret-path",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      },
    ]);
    expect(registered).toEqual([]);
    const notices: string[] = [];
    handlers.get("session_start")!(
      { type: "session_start", reason: "startup" },
      {
        cwd: "/work",
        ui: { notify: (message: string) => notices.push(message) },
      },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('server "remote": url must be');
    expect(notices[0]).not.toContain("secret");
  });
});
