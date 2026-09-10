import { writeFileSync, appendFileSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.on("session_start", () => {
    appendFileSync("mcp-runtime-paths", `${process.env.LODY_PI_MCP_CONFIG}\n`);
  });
  let release;
  let blockShutdown = false;
  pi.registerTool({
    name: "fixture_gate",
    label: "Fixture gate",
    description: "Wait for an explicit smoke signal",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await new Promise((resolve) => {
        const watcher = watch(process.cwd(), (_event, file) => {
          if (file === "release-gate") finish();
        });
        const finish = () => {
          watcher.close();
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        release = finish;
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
      return { content: [{ type: "text", text: "gate released" }] };
    },
  });
  pi.registerCommand("release-fixture", {
    description: "Release smoke gate",
    handler: async () => {
      release?.();
    },
  });
  pi.registerCommand("lody-steer", {
    description: "Ordinary extension command with the former internal name",
    handler: async () => {
      throw new Error("Wrong steer owner");
    },
  });
  for (const kind of ["new", "fork", "switch", "reload", "failed-reload"]) {
    pi.registerCommand(`native-${kind}-fixture`, {
      description: "Exercise native lifecycle",
      handler: async (_args, ctx) => {
        if (kind === "new") await ctx.newSession();
        else if (kind === "fork")
          await ctx.fork(ctx.sessionManager.getLeafId(), { position: "at" });
        else if (kind === "switch")
          await ctx.newSession({
            withSession: async (fresh) => {
              await fresh.switchSession(fresh.sessionManager.getSessionFile());
            },
          });
        else {
          if (kind === "failed-reload")
            writeFileSync(
              process.env.LODY_PI_MCP_CONFIG,
              JSON.stringify([
                {
                  name: "broken",
                  command: "/missing-mcp-fixture",
                  args: [],
                  env: [],
                },
              ]),
            );
          await ctx.reload();
        }
      },
    });
  }
  pi.on("before_agent_start", (event) => {
    if (event.prompt === "dynamic MCP collision fixture")
      pi.registerTool({
        name: "mcp_fixture_echo",
        label: "Collision",
        description: "Synthetic conflicting tool",
        parameters: Type.Object({ value: Type.String() }),
        execute: async () => ({
          content: [{ type: "text", text: "WRONG_MCP_OWNER" }],
        }),
      });
  });
  pi.on("session_shutdown", async () => {
    if (!blockShutdown) return;
    await writeFile("shutdown-observed", "yes\n");
    await new Promise(() => {});
  });

  pi.registerProvider("lody-fixture", {
    api: "lody-fixture-api",
    baseUrl: "http://fixture.invalid",
    apiKey: "fixture-only",
    models: [
      {
        id: "fixture",
        name: "Offline fixture",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const input = JSON.stringify(last?.content);
      if (last?.role === "user" && input.includes("content fixture"))
        writeFileSync("content-observed.json", JSON.stringify(last.content));
      const mcpTool =
        last?.role === "user" &&
        (input.includes("dynamic MCP collision fixture")
          ? "echo"
          : input.match(/mcp fixture (echo|wait|error|image)/)?.[1]);
      if (input.includes("process fixture")) {
        blockShutdown = true;
        writeFileSync("pi.pid", `${process.pid}\n`);
      }
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (
          context.tools?.length &&
          last?.role === "user" &&
          (mcpTool ||
            input.includes("question fixture") ||
            input.includes("write fixture") ||
            input.includes("gate fixture") ||
            input.includes("process fixture"))
        ) {
          const gate = input.includes("gate fixture");
          const processTool = input.includes("process fixture");
          const question = input.includes("question fixture");
          const tool = {
            type: "toolCall",
            id: "write-fixture",
            name: question
              ? "question"
              : mcpTool
                ? `mcp_fixture_${mcpTool}`
                : gate
                  ? "fixture_gate"
                  : processTool
                    ? "bash"
                    : "write",
            arguments: question
              ? {
                  question: "Choose a route",
                  options: [
                    { label: "Same", description: "First route" },
                    { label: "Same", description: "Second route" },
                  ],
                }
              : mcpTool
                ? mcpTool === "echo"
                  ? { value: "native-value" }
                  : {}
                : gate
                  ? {}
                  : processTool
                    ? {
                        command:
                          "echo $$ > process.pid; exec /bin/cat process.fifo",
                      }
                    : {
                        path: "fixture.txt",
                        content: "native pi wrote this\n",
                      },
          };
          message.content = [tool];
          message.stopReason = "toolUse";
          stream.push({
            type: "toolcall_start",
            contentIndex: 0,
            partial: message,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: tool,
            partial: message,
          });
        } else {
          const text =
            last?.role === "toolResult" && last.toolName.startsWith("mcp_")
              ? "MCP_RESULT " +
                JSON.stringify({ isError: last.isError, content: last.content })
              : JSON.stringify(context.messages).includes("steered fixture")
                ? "Pi steer applied"
                : "Pi native smoke passed";
          message.content = [{ type: "text", text }];
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: message,
          });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: text,
            partial: message,
          });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("input", (event) =>
    event.text === "handled fixture" ? { action: "handled" } : undefined,
  );
  pi.registerCommand("ask-fixture", {
    description: "Synthetic question",
    handler: async (args, ctx) => {
      const kind = args.trim() || "input";
      const value =
        kind === "select"
          ? await ctx.ui.select("Fixture select", ["chosen", "other"])
          : kind === "confirm"
            ? await ctx.ui.confirm("Fixture confirm", "Continue?")
            : kind === "editor"
              ? await ctx.ui.editor("Fixture editor", "prefilled text")
              : await ctx.ui.input("Fixture input");
      await writeFile(
        join(ctx.cwd, "fixture-answer.json"),
        JSON.stringify({ kind, value: value ?? null }),
      );
    },
  });
}
