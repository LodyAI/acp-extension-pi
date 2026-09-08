import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSideConnection,
  RequestError,
  type Agent,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  LODY_EXTENSION_METHODS,
  normalizeLodyExtensionMethod,
} from "acp-extension-core";
import { PiRpcConnection, initializeResponse } from "./connection.js";
import { MCP_CONFIG_ENV } from "./mcp.js";

const SHUTDOWN_GRACE_MS = 1_000;

function waitForExit(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolve(false);
    }, SHUTDOWN_GRACE_MS);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", exited);
  });
}

/** One runtime per ACP connection; Pi owns its native files and tool processes. */
export function serve(stream: Stream, piArgs: string[] = []) {
  let child: ChildProcess | undefined;
  let runtime: Promise<PiRpcConnection> | undefined;
  let cwd: string | undefined;
  let closing: Promise<void> | undefined;
  let configDirectory: string | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      try {
        const owned = child;
        if (!owned?.pid || owned.exitCode !== null || owned.signalCode !== null)
          return;
        if (process.platform === "win32") owned.stdin?.end();
        else {
          // Pi's SIGTERM handler stops tracked detached tools before awaiting shutdown hooks.
          try {
            process.kill(-owned.pid, "SIGTERM");
          } catch {
            /* Already exited. */
          }
        }
        if (await waitForExit(owned)) return;
        if (process.platform === "win32") {
          await new Promise<void>((resolve) => {
            const killer = spawn(
              "taskkill",
              ["/pid", String(owned.pid), "/T", "/F"],
              { stdio: "ignore" },
            );
            killer.once("error", () => {
              owned.kill();
              resolve();
            });
            killer.once("exit", () => resolve());
          });
        } else {
          try {
            process.kill(-owned.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        await waitForExit(owned);
      } finally {
        if (configDirectory)
          rmSync(configDirectory, { recursive: true, force: true });
      }
    })();
    return closing;
  };
  const connection = new AgentSideConnection((client): Agent => {
    const get = async (directory?: string) => {
      if (closing) throw new Error("ACP connection closed");
      if (runtime) {
        if (directory && directory !== cwd)
          throw RequestError.invalidRequest(
            undefined,
            "Use another ACP connection for a different working directory",
          );
        return runtime;
      }
      if (!directory)
        throw RequestError.invalidRequest(
          undefined,
          "Create or resume a session first",
        );
      cwd = directory;
      configDirectory = mkdtempSync(join(tmpdir(), "lody-pi-mcp-"));
      const configPath = join(configDirectory, "servers.json");
      writeFileSync(configPath, "[]", { mode: 0o600 });
      const entry = fileURLToPath(
        new URL(
          "./bundle/cli.js",
          import.meta.resolve("@earendil-works/pi-coding-agent"),
        ),
      );
      child = spawn(
        process.execPath,
        [
          entry,
          ...piArgs,
          "--mode",
          "rpc",
          "-e",
          fileURLToPath(new URL("./extension.js", import.meta.url)),
        ],
        {
          cwd,
          env: { ...process.env, [MCP_CONFIG_ENV]: configPath },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      child.once("exit", () => void close());
      child.stderr!.pipe(process.stderr, { end: false });
      const pi = new PiRpcConnection(
        {
          protocol: "pi",
          writable: Writable.toWeb(child.stdin!),
          readable: Readable.toWeb(child.stdout!),
        },
        {
          configureMcp: async (servers) => {
            // Called only inside PiRpcConnection's existing configuration exclusion.
            if (closing) throw new Error("ACP connection closed");
            const pendingPath = configPath + ".pending";
            writeFileSync(pendingPath, JSON.stringify(servers), {
              mode: 0o600,
            });
            renameSync(pendingPath, configPath);
          },
          update: (notification) => client.sessionUpdate(notification),
          // Notifications are sent in Pi event order. Lody owns the application lease
          // and gates session updates after the matching Core notification arrives.
          extension: (method, params) => client.extNotification(method, params),
          usage: (usage) => {
            void client
              .extNotification(LODY_EXTENSION_METHODS.sessionUsageUpdate, {
                ...usage,
              })
              .catch(close);
          },
          question: (request) => client.unstable_createElicitation(request),
        },
      );
      runtime = Promise.race([
        pi.initialize({ protocolVersion: 1 }).then(() => pi),
        new Promise<never>((_resolve, reject) => child!.once("error", reject)),
      ]);
      return runtime;
    };
    const validate = (request: { mcpServers?: unknown[] }) => {
      if (
        request.mcpServers?.some(
          (server) =>
            !server || typeof server !== "object" || !("command" in server),
        )
      )
        throw RequestError.invalidRequest(
          undefined,
          "Pi supports stdio MCP servers only",
        );
    };
    return {
      initialize: async () => initializeResponse(),
      authenticate: async () => {
        throw RequestError.invalidRequest(
          undefined,
          "Authenticate through Pi on the execution machine",
        );
      },
      newSession: async (request) => {
        validate(request);
        return (await get(request.cwd)).newSession(request);
      },
      resumeSession: async (request) => {
        validate(request);
        return (await get(request.cwd)).resumeSession(request);
      },
      prompt: async (request) => (await get()).prompt(request),
      cancel: async (request) => {
        await (await get()).cancel(request);
      },
      setSessionConfigOption: async (request) =>
        (await get()).setSessionConfigOption(request),
      extMethod: async (method, params) =>
        (await get()).request(normalizeLodyExtensionMethod(method), params),
    };
  }, stream);
  connection.signal.addEventListener("abort", () => void close(), {
    once: true,
  });
  return { connection, close };
}
