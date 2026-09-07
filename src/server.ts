import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
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

/** One runtime per ACP connection; Pi owns its native files and tool processes. */
export function serve(stream: Stream, piArgs: string[] = []) {
  let child: ChildProcess | undefined;
  let runtime: Promise<PiRpcConnection> | undefined;
  let cwd: string | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      }).on("error", () => child?.kill());
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  };
  const connection = new AgentSideConnection((client): Agent => {
    const get = async (directory?: string) => {
      if (closed) throw new Error("ACP connection closed");
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
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      child.once("exit", close);
      child.stderr!.pipe(process.stderr, { end: false });
      const pi = new PiRpcConnection(
        {
          protocol: "pi",
          writable: Writable.toWeb(child.stdin!),
          readable: Readable.toWeb(child.stdout!),
        },
        {
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
      if (request.mcpServers?.length)
        throw RequestError.invalidRequest(
          undefined,
          "Pi does not support workspace MCP servers",
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
  connection.signal.addEventListener("abort", close, { once: true });
  return { connection, close };
}
