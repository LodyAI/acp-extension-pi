import spawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { LodySubagentTask, LodyTaskMeta } from "acp-extension-core";
import { z } from "zod";
import { PI_EXTENSIONS_ENV } from "./extensions.js";
import { resolvePiLaunch } from "./launch.js";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
type Task = {
  info: LodySubagentTask;
  output: string;
  finished: Promise<void>;
  cancel: () => Promise<void>;
};

/** The process owner supplies identity, terminal status and cancellation to Lody. */
export function registerSubagents(
  pi: ExtensionAPI,
  emit: (ctx: ExtensionContext, event: unknown) => void,
) {
  const tasks = new Map<string, Task>();
  pi.on("session_shutdown", async () => {
    await Promise.all([...tasks.values()].map((task) => task.cancel()));
    tasks.clear();
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a focused task to an isolated Pi agent and wait for its result. It cannot ask the user or spawn further subagents; return missing information to the main agent.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        description: { type: "string" },
        model: {
          type: "string",
          description:
            "Optional provider/model-id of an available Pi model. Omit to use the current model.",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_SECONDS,
          description:
            "Total execution time limit in seconds, including startup and tools. Defaults to 1800 (30 minutes); maximum 86400 (24 hours). On timeout the child is stopped and an error is returned.",
        },
      },
      required: ["task", "description"],
    } as ToolDefinition["parameters"],
    async execute(parentToolCallId, input, signal, _update, ctx) {
      const args = z
        .object({
          task: z.string().min(1),
          description: z.string().min(1),
          model: z.string().min(1).optional(),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(MAX_TIMEOUT_SECONDS)
            .default(DEFAULT_TIMEOUT_SECONDS),
        })
        .parse(input);
      if (signal?.aborted) throw new Error("Subagent cancelled before launch");
      const model = args.model
        ? resolveModel(ctx, args.model)
        : ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
      if (!model) throw new Error("Select a model before starting a subagent");
      const id = randomUUID();
      const extensions: string[] = JSON.parse(
        process.env[PI_EXTENSIONS_ENV] ?? "[]",
      );
      const { command, args: launchArgs } = resolvePiLaunch([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "-e",
        "builtin:codemode",
        ...extensions.flatMap((path) => ["-e", path]),
        "--model",
        model,
        "--thinking",
        pi.getThinkingLevel(),
        "-e",
        fileURLToPath(new URL("./child-context.js", import.meta.url)),
        "--",
        args.task,
      ]);
      const proc = spawn(command, launchArgs, {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Stay in the parent Pi process group so adapter shutdown also kills
        // children if Pi cannot finish its cooperative shutdown hook.
        detached: false,
        windowsHide: true,
      });
      let finish!: () => void;
      let cancellation: Promise<void> | undefined;
      let forced: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let stopGraceElapsed = false;
      let timedOut = false;
      let failed = false;
      let buffer = "";
      let messageId = randomUUID();
      let lastToolName: string | undefined;
      const info: LodySubagentTask = {
        taskId: id,
        description: args.description,
        status: "running",
        modelId: model,
        startedAtEpochSeconds: Date.now() / 1000,
        endedAtEpochSeconds: null,
      };
      const publish = (event: "started" | "updated" = "updated") => {
        const meta: LodyTaskMeta = {
          version: 1,
          taskId: id,
          kind: "subagent",
          parentToolCallId,
          description: info.description,
          modelId: info.modelId,
          status:
            info.status === "running"
              ? "in_progress"
              : info.status === "completed"
                ? "completed"
                : "failed",
          startedAtEpochSeconds: info.startedAtEpochSeconds,
          ...(info.endedAtEpochSeconds === null
            ? {}
            : { endedAtEpochSeconds: info.endedAtEpochSeconds }),
          ...(info.stopReason ? { error: info.stopReason } : {}),
          ...(lastToolName ? { lastToolName } : {}),
        };
        emit(ctx, {
          type: "lody_subagent",
          event,
          task: meta,
          state: info.status,
        });
      };
      const kill = (force: boolean) => {
        if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid)
          return;
        if (process.platform === "win32") {
          const killer = spawn(
            join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/pid", String(proc.pid), "/T", ...(force ? ["/F"] : [])],
            { stdio: "ignore", windowsHide: true },
          );
          killer.on("error", () => proc.kill(force ? "SIGKILL" : "SIGTERM"));
        } else {
          try {
            proc.kill(force ? "SIGKILL" : "SIGTERM");
          } catch {
            /* Already exited. */
          }
        }
      };
      const closeCancelledPipes = () => {
        if (
          cancellation &&
          stopGraceElapsed &&
          (proc.exitCode !== null || proc.signalCode !== null)
        ) {
          // A descendant can keep inherited stdio open after Pi exits. Allow
          // final buffered output to drain during the stop grace, then close
          // these readers so inherited pipes cannot keep the tool waiting.
          // This does not claim to terminate detached descendant processes.
          proc.stdout!.destroy();
          proc.stderr!.destroy();
        }
      };
      const task: Task = {
        info,
        output: "",
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        cancel: () => {
          if (info.status !== "running") return task.finished;
          if (cancellation) return cancellation;
          cancellation = task.finished;
          if (deadline) clearTimeout(deadline);
          kill(false);
          forced = setTimeout(() => {
            stopGraceElapsed = true;
            kill(true);
            closeCancelledPipes();
          }, 1000);
          return cancellation;
        },
      };
      tasks.set(id, task);
      publish("started");
      const append = (text: string) => {
        task.output = (task.output + text).slice(-MAX_OUTPUT);
      };
      proc.stderr!.on("data", (chunk) => append(String(chunk)));
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) {
          failed = true;
          void task.cancel();
          return;
        }
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_start") messageId = randomUUID();
            if (
              [
                "message_update",
                "tool_execution_start",
                "tool_execution_update",
                "tool_execution_end",
              ].includes(event.type)
            ) {
              emit(ctx, {
                type: "lody_subagent_output",
                taskId: id,
                messageId,
                event,
              });
            }
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent?.type === "text_delta"
            ) {
              append(String(event.assistantMessageEvent.delta ?? ""));
            }
            if (event.type === "tool_execution_start") {
              lastToolName = String(event.toolName);
              publish();
            }
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            ) {
              // Child usage is live-only (--no-session); forward just its accounting fields.
              const { provider, model, responseId, timestamp, usage } =
                event.message;
              emit(ctx, {
                type: "lody_usage",
                taskId: id,
                message: {
                  role: "assistant",
                  provider,
                  model,
                  responseId,
                  timestamp,
                  usage,
                },
              });
              append("\n");
              failed = ["error", "aborted", "length"].includes(
                event.message.stopReason,
              );
              if (failed) {
                info.stopReason =
                  event.message.errorMessage ?? event.message.stopReason;
              } else info.stopReason = undefined;
            }
          } catch {
            failed = true;
            append("Invalid Pi subagent output\n");
            void task.cancel();
          }
        }
      });
      proc.on("error", (error) => {
        failed = true;
        info.stopReason = error.message;
      });
      const abort = () => {
        void task.cancel();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      proc.once("exit", closeCancelledPipes);
      proc.once("close", (code) => {
        if (deadline) clearTimeout(deadline);
        if (forced) clearTimeout(forced);
        proc.removeListener("exit", closeCancelledPipes);
        signal?.removeEventListener("abort", abort);
        info.status = timedOut
          ? "failed"
          : cancellation
            ? "killed"
            : failed || code !== 0
              ? "failed"
              : "completed";
        info.endedAtEpochSeconds = Date.now() / 1000;
        if (timedOut)
          info.stopReason = `Subagent timed out after ${args.timeoutSeconds} seconds`;
        else if (info.status === "killed") info.stopReason = "Cancelled";
        else if (info.status === "failed")
          info.stopReason ??= `Pi exited with code ${code}`;
        publish();
        finish();
      });
      if (!cancellation) {
        deadline = setTimeout(() => {
          timedOut = true;
          void task.cancel();
        }, args.timeoutSeconds * 1000);
      }
      await task.finished;
      return {
        content: [
          {
            type: "text" as const,
            text:
              [info.stopReason, task.output].filter(Boolean).join("\n") ||
              "Subagent completed without text output",
          },
        ],
        details: {
          taskId: id,
          status: info.status,
          isError: info.status !== "completed",
        },
      };
    },
  });
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "subagent" &&
      (event.details as { isError?: boolean } | undefined)?.isError
    )
      return { isError: true };
  });
  return async (request: {
    op: string;
    taskId?: string;
    activeOnly?: boolean;
    tail?: number;
  }) => {
    if (request.op === "list")
      return {
        tasks: [...tasks.values()]
          .filter(
            (task) => !request.activeOnly || task.info.status === "running",
          )
          .map((task) => task.info),
      };
    const task = tasks.get(request.taskId ?? "");
    if (!task) throw new Error("Unknown Pi subagent task");
    if (request.op === "cancel") {
      await task.cancel();
      return {};
    }
    if (request.op === "output")
      return {
        output: task.output.slice(
          -Math.max(1, Math.min(request.tail ?? MAX_OUTPUT, MAX_OUTPUT)),
        ),
      };
    throw new Error("Unsupported subagent operation");
  };
}

function resolveModel(ctx: ExtensionContext, requested: string): string {
  const available = ctx.modelRegistry.getAvailable();
  const slash = requested.indexOf("/");
  const provider = requested.slice(0, slash);
  const match = available.find(
    (model) =>
      slash > 0 &&
      model.provider === provider &&
      model.id === requested.slice(slash + 1),
  );
  if (match) return `${match.provider}/${match.id}`;
  const sameProvider = available.filter((model) => model.provider === provider);
  const hint = sameProvider.length
    ? `Available ${provider} models: ${list(sameProvider.map((model) => model.id))}`
    : `Available providers: ${list([...new Set(available.map((model) => model.provider))])}`;
  throw new Error(
    `Model "${requested}" is not an available provider/model-id. ${hint}`,
  );
}

const MAX_HINTS = 20;

function list(names: string[]): string {
  if (!names.length) return "none";
  const shown = names.slice(0, MAX_HINTS).join(", ");
  return names.length > MAX_HINTS
    ? `${shown} and ${names.length - MAX_HINTS} more`
    : shown;
}
