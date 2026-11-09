import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionAPI,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";

export const MCP_CONFIG_ENV = "LODY_PI_MCP_CONFIG";
type StdioServer = Extract<McpServer, { command: string }>;
type HttpServer = Extract<McpServer, { url: string }>;
type SelectedServer = StdioServer | HttpServer;

/**
 * Pi resolves `$NAME`, `${NAME}` and a leading `!command` in env and header values.
 * ACP values are already final, so escape them to reach the server unchanged.
 */
export function literalConfigValue(value: string): string {
  const escaped = value.replaceAll("$", () => "$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

const literalRecord = (entries: { name: string; value: string }[]) =>
  Object.fromEntries(
    entries.map(({ name, value }) => [name, literalConfigValue(value)]),
  );

/** Pi's prompt section listing servers whose tools are reached through `tool_search`. */
export const MCP_SERVERS_SECTION = "mcp_servers";

const namespaceKey = (name: string) => name.replace(/-/g, "_");
const shortHash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 6);

/**
 * Pi server names allow only letters, digits, `_` and `-`, and `-`/`_` variants share
 * one tool namespace. Lody names are free-form display names. Names that collide after
 * mapping all take a hash of their server identity, so a resumed transcript's loaded
 * `mcp__<server>__*` tools keep pointing at the same server whatever the selection order.
 */
function serverNames(servers: readonly SelectedServer[]): string[] {
  const bases = servers.map(
    (server) => server.name.replace(/[^A-Za-z0-9_-]/g, "_") || "server",
  );
  const counts = new Map<string, number>();
  for (const base of bases)
    counts.set(namespaceKey(base), (counts.get(namespaceKey(base)) ?? 0) + 1);
  const taken = new Set<string>();
  return servers.map((server, index) => {
    const base = bases[index]!;
    let name = base;
    if (counts.get(namespaceKey(base))! > 1) {
      const target =
        "url" in server ? [server.url] : [server.command, ...server.args];
      name = `${base}_${shortHash(JSON.stringify([server.name, ...target]))}`;
    }
    // Only an exact duplicate (same name and target) still collides.
    const unique = name;
    for (let suffix = 2; taken.has(namespaceKey(name)); suffix++)
      name = `${unique}_${suffix}`;
    taken.add(namespaceKey(name));
    return name;
  });
}

/** The ACP selection as Pi MCP servers whose tools `tool_search` loads on demand. */
export function toPiMcpServers(
  servers: readonly SelectedServer[],
): { name: string; config: McpServerConfig }[] {
  const names = serverNames(servers);
  return servers.map((server, index) => ({
    name: names[index]!,
    config:
      "url" in server
        ? {
            type: "http",
            url: server.url,
            headers: literalRecord(server.headers),
            exposure: "deferred",
          }
        : {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: literalRecord(server.env),
            exposure: "deferred",
          },
  }));
}

/**
 * Loaded in Pi: Pi's own MCP extension connects the ACP-selected servers. It reads no
 * mcp.json, so the session uses only the servers Lody selected.
 */
export function registerMcp(pi: ExtensionAPI): void {
  const configPath = process.env[MCP_CONFIG_ENV];
  if (!configPath) throw new Error("Missing Lody Pi runtime configuration");
  const servers = JSON.parse(
    readFileSync(configPath, "utf8"),
  ) as SelectedServer[];
  const errors: string[] = [];
  for (const { name, config } of toPiMcpServers(servers)) {
    try {
      pi.registerMcpServer(name, config);
    } catch (error) {
      // Pi's validation messages name the field, never its value.
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  createToolSearchExtension()(pi);
  createMcpExtension({
    loadConfig: () => ({ servers: [], errors, autoEnableCodemode: false }),
    logPath: join(dirname(configPath), "mcp.log"),
    // RPC mode has no browser hand-off; servers that need OAuth report it instead.
    openUrl: () => {},
  })(pi);
}
