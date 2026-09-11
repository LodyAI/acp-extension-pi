import type { PiStream } from "../src/types.js";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PiRpcConnection, initializeResponse } from "../src/connection.js";
import {
  LODY_EXTENSION_METHODS,
  type SessionUsageUpdate,
} from "acp-extension-core";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const model = {
  provider: "fixture",
  id: "one",
  name: "Fixture",
  contextWindow: 4096,
};
const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { total: 0.01 },
};

/** Synthetic wire peer. Writes never await a running prompt or a question. */
function peer() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      output = controller;
    },
  });
  const commands: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const promptReceived = deferred();
  const accepted = deferred();
  const questionAnswered = deferred<Record<string, unknown>>();
  const state = {
    sessionId: "native-id",
    sessionFile: "/work/pi-session.jsonl",
    model,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  };
  const emit = (value: unknown) =>
    output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  let defaultPrompt: Record<string, unknown> | undefined;
  const finish = () => {
    emit({ type: "agent_settled" });
    if (defaultPrompt) {
      reply(defaultPrompt);
      defaultPrompt = undefined;
    }
  };
  let onPrompt = (request: Record<string, unknown>) => {
    defaultPrompt = request;
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
  };
  let onAbort = (request: Record<string, unknown>) => {
    finish();
    reply(request);
  };
  let onClearQueue = (request: Record<string, unknown>) => reply(request, {});
  let onCompact = (request: Record<string, unknown>) => reply(request, {});
  let onState = (request: Record<string, unknown>) => reply(request, state);
  let onStats = (request: Record<string, unknown>) =>
    reply(request, {
      tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
      cost: 0.02,
    });
  function reply(
    request: Record<string, unknown>,
    data?: unknown,
    error?: string,
  ) {
    emit({
      type: "response",
      id: request.id,
      command: request.type,
      success: !error,
      data,
      error,
    });
  }
  let onSession = (request: Record<string, unknown>) =>
    reply(request, { cancelled: false });
  let onModel = (request: Record<string, unknown>) => {
    state.model = { ...model, id: String(request.modelId) };
    state.thinkingLevel = "off";
    reply(request, state.model);
  };
  let onModels = (request: Record<string, unknown>) =>
    reply(request, { models: [model, { ...model, id: "two" }] });
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      const request: Record<string, unknown> = JSON.parse(
        new TextDecoder().decode(bytes),
      );
      commands.push(request);
      switch (request.type) {
        case "new_session":
        case "switch_session":
          onSession(request);
          emit({
            type: "extension_ui_request",
            method: "notify",
            message:
              "lody-rpc:" +
              JSON.stringify({
                type: "lody_steer_ready",
                version: 1,
                command: "lody-steer",
                sessionFile: state.sessionFile,
              }),
          });
          break;
        case "get_state":
          onState(request);
          if (commands.some((command) => command.type === "prompt"))
            accepted.resolve();
          break;
        case "get_session_stats":
          onStats(request);
          break;
        case "get_available_models":
          onModels(request);
          break;
        case "get_available_thinking_levels":
          reply(request, {
            levels: state.model.id === "one" ? ["off", "high"] : ["off"],
          });
          break;
        case "set_model":
          onModel(request);
          break;
        case "set_thinking_level":
          state.thinkingLevel = String(request.level);
          reply(request);
          break;
        case "prompt":
          onPrompt(request);
          promptReceived.resolve();
          break;
        case "abort":
          onAbort(request);
          break;
        case "compact":
          onCompact(request);
          break;
        case "clear_queue":
          onClearQueue(request);
          break;
        case "extension_ui_response":
          replies.push(request);
          questionAnswered.resolve(request);
          break;
        default:
          throw new Error(`Unexpected Pi wire method: ${String(request.type)}`);
      }
    },
  });
  const stream: PiStream = { readable, writable };
  emit({
    type: "extension_ui_request",
    method: "notify",
    message:
      "lody-rpc:" +
      JSON.stringify({
        type: "lody_steer_ready",
        version: 1,
        command: "lody-steer",
        sessionFile: state.sessionFile,
      }),
  });
  const updates: acp.SessionNotification[] = [];
  const usages: SessionUsageUpdate[] = [];
  let client: PiRpcConnection | undefined;
  const host = {
    configureMcp: async (_servers: acp.McpServer[]) => {},
    update: async (notification: acp.SessionNotification) => {
      updates.push(notification);
    },
    extension: async (_method: string, _params: Record<string, unknown>) => {},
    usage: (value: SessionUsageUpdate) => usages.push(value),
    question: async (): Promise<acp.CreateElicitationResponse> => ({
      action: "accept",
      content: { answer: "chosen" },
    }),
  };
  return {
    setCompact(handler: typeof onCompact) {
      onCompact = handler;
    },
    setState(handler: typeof onState) {
      onState = handler;
    },
    setStats(handler: typeof onStats) {
      onStats = handler;
    },
    setSession(handler: typeof onSession) {
      onSession = handler;
    },
    setModel(handler: typeof onModel) {
      onModel = handler;
    },
    setModels(handler: typeof onModels) {
      onModels = handler;
    },
    get client() {
      return (client ??= new PiRpcConnection(stream, host));
    },
    stream,
    readable,
    writable,
    updates,
    usages,
    host,
    emit,
    finish,
    commands,
    state,
    replies,
    questionAnswered,
    reply,
    promptReceived,
    accepted,
    setAbort: (handler: typeof onAbort) => {
      onAbort = handler;
    },
    setClearQueue: (handler: typeof onClearQueue) => {
      onClearQueue = handler;
    },
    setPrompt: (handler: typeof onPrompt) => {
      onPrompt = handler;
    },
    close: () => output.close(),
  };
}
async function start(p: ReturnType<typeof peer>) {
  await p.client.initialize({ protocolVersion: 1 });
  return p.client.newSession({ cwd: "/work", mcpServers: [] });
}
const prompt = {
  sessionId: "/work/pi-session.jsonl",
  prompt: [{ type: "text" as const, text: "hello" }],
};
const text = (value: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: value },
});

describe("native Pi connection", () => {
  it("projects visible extension output without exposing hidden context or turning notices into failure", async () => {
    const p = peer();
    await start(p);
    p.emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "fixture",
        display: true,
        content: "idle visible",
      },
    });
    p.setPrompt((request) => {
      for (const [customType, display, content] of [
        ["fixture", true, "visible"],
        ["fixture", false, "hidden"],
        ["lody-steer", true, "owned-steer"],
      ] as const)
        p.emit({
          type: "message_end",
          message: { role: "custom", customType, display, content },
        });
      p.emit({
        type: "extension_ui_request",
        id: "notice",
        method: "notify",
        message: "extension error notice",
        notifyType: "error",
      });
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
        .map((n) => n.update),
    ).toEqual(
      ["idle visible", "visible"].map((text) => ({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      })),
    );
    expect(p.updates).toContainEqual({
      sessionId: prompt.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          lody: {
            notice: {
              level: "error",
              message: "extension error notice",
              source: "pi",
            },
          },
        },
      },
    });
    p.close();
  });
  it.each(["success", "error", "cancel", "disconnect"])(
    "settles extension-owned compaction and admits recovery (%s)",
    async (outcome) => {
      const p = peer();
      await start(p);
      let command!: Record<string, unknown>;
      p.setPrompt((request) => {
        command = request;
        p.state.isCompacting = true;
        p.emit({ type: "compaction_start", reason: "manual" });
      });
      const result = p.client.prompt(prompt);
      const assertion =
        outcome === "error" || outcome === "disconnect"
          ? expect(result).rejects.toThrow(
              outcome === "error" ? "Summary failed" : "closed",
            )
          : expect(result).resolves.toMatchObject({
              stopReason: outcome === "cancel" ? "cancelled" : "end_turn",
            });
      await p.promptReceived.promise;
      await expect(p.client.prompt(prompt)).rejects.toThrow();
      const end = () => {
        p.state.isCompacting = false;
        p.setStats((request) =>
          p.reply(request, {
            tokens: { input: 99, output: 10, cacheRead: 4, cacheWrite: 2 },
            cost: 0.03,
          }),
        );
        p.emit({
          type: "compaction_end",
          reason: "manual",
          aborted: outcome === "cancel",
          errorMessage: outcome === "error" ? "Summary failed" : undefined,
          result: outcome === "success" ? { tokensBefore: 100 } : undefined,
        });
        p.reply(command);
      };
      if (outcome === "cancel") {
        p.setAbort((request) => {
          end();
          p.reply(request);
        });
        await p.client.cancel({ sessionId: prompt.sessionId });
      } else if (outcome === "disconnect") p.close();
      else end();
      await assertion;
      if (outcome !== "disconnect") {
        expect(p.usages.at(-1)?.usage.inputTokens).toBe(99);
        p.setPrompt((request) => {
          p.reply(request);
        });
        await expect(p.client.prompt(prompt)).resolves.toMatchObject({
          stopReason: "end_turn",
        });
        p.close();
      }
    },
  );
  it.each(["reply-error", "eof"])(
    "distinguishes optional initial stats failure from a dead Pi transport (%s)",
    async (failure) => {
      const p = peer();
      p.setStats((request) => {
        if (failure === "eof") p.close();
        else p.reply(request, undefined, "Stats unavailable");
      });
      const result = start(p);
      if (failure === "eof") {
        await expect(result).rejects.toThrow("Pi RPC connection closed");
        await expect(p.client.prompt(prompt)).rejects.toThrow();
      } else {
        await expect(result).resolves.toMatchObject({
          sessionId: prompt.sessionId,
        });
        p.close();
      }
    },
  );

  it("rejects extension-owned replacement and failed reload, then allows explicit recovery", async () => {
    const p = peer();
    await start(p);
    for (const replacement of [false, true]) {
      p.setPrompt((request) => {
        p.emit({ type: "lody_not_ready" });
        if (replacement) {
          p.state.sessionFile = "/work/replaced.jsonl";
          p.emit({
            type: "lody_steer_ready",
            version: 1,
            command: "private-steer",
            sessionFile: p.state.sessionFile,
          });
        }
        p.reply(request);
      });
      await expect(p.client.prompt(prompt)).rejects.toThrow(
        /initialize|changed its native session/,
      );
      await expect(p.client.prompt(prompt)).rejects.toThrow();
      const next = await p.client.newSession({ cwd: "/work", mcpServers: [] });
      expect(next.sessionId).toBe(p.state.sessionFile);
    }
    p.close();
  });

  it.each([false, true])(
    "preserves final length but clears it after a successful retry (%s)",
    async (retry) => {
      const p = peer();
      await start(p);
      p.setPrompt((request) => {
        p.emit({ type: "agent_start" });
        p.emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "length" },
        });
        if (retry) {
          p.emit({ type: "message_start", message: { role: "assistant" } });
          p.emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "stop" },
          });
        }
        p.finish();
        p.reply(request);
      });
      expect(await p.client.prompt(prompt)).toEqual({
        stopReason: retry ? "end_turn" : "max_tokens",
      });
      p.close();
    },
  );

  it.each([false, true])(
    "keeps accepted Stop authoritative while stats is pending (failed=%s)",
    async (failed) => {
      const p = peer();
      await start(p);
      const stats = deferred<Record<string, unknown>>();
      p.setStats((request) => stats.resolve(request));
      const result = p.client.prompt({
        ...prompt,
        prompt: [{ type: "text", text: "/stats" }],
      });
      const request = await stats.promise;
      const stopped = p.client.cancel({ sessionId: prompt.sessionId });
      p.reply(
        request,
        {
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        },
        failed ? "Stats failed" : undefined,
      );
      expect(await result).toEqual({ stopReason: "cancelled" });
      await stopped;
      expect(
        p.updates.some((n) => n.update.sessionUpdate === "agent_message_chunk"),
      ).toBe(false);
      p.close();
    },
  );

  it.each(["stop", "length", "error", "aborted", "handled"])(
    "keeps %s authoritative when post-turn model options disappear",
    async (outcome) => {
      const p = peer();
      await start(p);
      p.setPrompt((request) => {
        p.setModels((query) => p.reply(query, { models: [] }));
        if (outcome !== "handled") {
          p.emit({ type: "agent_start" });
          p.emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: outcome,
              errorMessage: "Model failed",
            },
          });
          p.finish();
        }
        p.reply(request);
      });
      const result = p.client.prompt(prompt);
      if (outcome === "error")
        await expect(result).rejects.toThrow("Model failed");
      else
        expect(await result).toEqual({
          stopReason:
            outcome === "length"
              ? "max_tokens"
              : outcome === "aborted"
                ? "cancelled"
                : "end_turn",
        });
      p.close();
    },
  );

  it("does not hide a failed ACP configuration notification as an optional refresh failure", async () => {
    const p = peer();
    await start(p);
    p.host.update = async ({ update }) => {
      if (update.sessionUpdate === "config_option_update")
        throw new Error("ACP output closed");
    };
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.finish();
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).rejects.toThrow("ACP output closed");
    p.close();
  });

  it("uses Pi context snapshots instead of assistant usage, preserving unknown occupancy", async () => {
    const p = peer();
    await start(p);
    for (const tokens of [321, null]) {
      p.updates.length = 0;
      p.setStats((query) =>
        p.reply(query, {
          tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
          cost: 0.02,
          contextUsage: { tokens, contextWindow: 8192 },
        }),
      );
      p.setPrompt((request) => {
        p.emit({ type: "agent_start" });
        p.emit({ ...text("answer"), usage: { ...usage, totalTokens: 0 } });
        p.emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", usage },
        });
        p.emit({
          type: "tool_execution_start",
          toolCallId: "next-tool",
          toolName: "bash",
          args: { command: "echo next" },
        });
        p.finish();
        p.reply(request);
      });
      expect(await p.client.prompt(prompt)).toEqual({ stopReason: "end_turn" });
      const snapshots = p.updates
        .map((n) => n.update)
        .filter((u) => u.sessionUpdate === "usage_update");
      if (tokens === null) expect(snapshots).toEqual([]);
      else {
        expect(snapshots.length).toBeGreaterThan(0);
        for (const snapshot of snapshots)
          expect(snapshot).toMatchObject({ used: tokens, size: 8192 });
        const events = p.updates.map((n) => n.update.sessionUpdate);
        expect(events.indexOf("usage_update")).toBeLessThan(
          events.indexOf("tool_call"),
        );
      }
    }
    p.close();
  });

  it("refreshes extension-selected model and thinking after a handled command", async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => {
      p.state.model = { ...model, id: "two" };
      p.state.thinkingLevel = "off";
      p.reply(request);
    });
    await p.client.prompt(prompt);
    expect(
      p.updates.find((n) => n.update.sessionUpdate === "config_option_update"),
    ).toMatchObject({
      update: {
        configOptions: [
          { id: "model", currentValue: "fixture/two" },
          { id: "thinking", currentValue: "off" },
        ],
      },
    });
    p.close();
  });

  it("does not start a prompt midway through model configuration", async () => {
    const p = peer();
    await p.client.initialize({ protocolVersion: 1 });
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    const entered = deferred<Record<string, unknown>>();
    p.setModel((request) => entered.resolve(request));
    const setting = p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: "model",
      value: "fixture/two",
    });
    const command = await entered.promise;
    const turn = p.client.prompt(prompt).then(
      () => "completed",
      () => "refused",
    );
    const verdict = await Promise.race([
      turn,
      p.promptReceived.promise.then(() => "sent mid-configuration"),
    ]);
    if (verdict !== "refused") p.finish();
    p.state.model = { ...model, id: "two" };
    p.reply(command, p.state.model);
    await Promise.all([turn, setting]);
    p.close();
    expect(verdict).toBe("refused");
  });

  it("invalidates old identity when replacement startup configuration fails", async () => {
    const p = peer();
    await p.client.initialize({ protocolVersion: 1 });
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    p.setSession((request) => {
      p.state.sessionFile = "/work/next.jsonl";
      p.reply(request, { cancelled: false });
    });
    await expect(
      p.client.newSession({
        cwd: "/work",
        mcpServers: [],
        _meta: {
          lody: {
            sessionConfig: { configOptionValues: { model: "missing/model" } },
          },
        },
      }),
    ).rejects.toThrow("unavailable");
    await expect(p.client.prompt({ ...prompt, sessionId: "" })).rejects.toThrow(
      "does not match",
    );
    const oldTurn = p.client.prompt(prompt).then(
      () => "completed",
      () => "refused",
    );
    const verdict = await Promise.race([
      oldTurn,
      p.promptReceived.promise.then(() => "sent to replaced session"),
    ]);
    if (verdict !== "refused") p.finish();
    await oldTurn;
    p.close();
    expect(verdict).toBe("refused");
  });

  it("refuses an old-session prompt while native session replacement is in flight", async () => {
    const p = peer();
    await p.client.initialize({ protocolVersion: 1 });
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    const entered = deferred<Record<string, unknown>>();
    p.setSession((request) => {
      p.state.sessionFile = "/work/next.jsonl";
      entered.resolve(request);
    });
    const replacing = p.client.newSession({ cwd: "/work", mcpServers: [] });
    const command = await entered.promise;
    const oldTurn = p.client.prompt(prompt).then(
      () => "completed",
      () => "refused",
    );
    const verdict = await Promise.race([
      oldTurn,
      p.promptReceived.promise.then(() => "sent to replaced session"),
    ]);
    if (verdict !== "refused") p.finish();
    p.reply(command, { cancelled: false });
    await Promise.all([oldTurn, replacing]);
    p.close();
    expect(verdict).toBe("refused");
  });

  it("hands off a steer only when its tagged message is applied, before any following output", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await p.accepted.promise;
    const queued = deferred();
    p.setPrompt((request) => {
      p.reply(request);
      queued.resolve();
    });
    const applied = deferred();
    const released = deferred();
    const applications: unknown[] = [];
    p.host.extension = async (method, params) => {
      applications.push(params.steerId);
      expect(method).toBe(LODY_EXTENSION_METHODS.sessionSteerApplied);
      expect(params.sessionId).toBe(prompt.sessionId);
      if (params.steerId === "steer-1") {
        applied.resolve();
        await released.promise;
      }
    };
    const steered = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
      sessionId: prompt.sessionId,
      steerId: "steer-1",
      prompt: [{ type: "text", text: "change direction" }],
    });
    await queued.promise;
    p.emit({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "change direction" }],
      },
    });
    p.emit(text("old owner"));
    p.emit({
      type: "message_start",
      message: {
        role: "custom",
        customType: "lody-steer",
        details: { steerId: "steer-1" },
        content: "change direction",
      },
    });
    p.emit(text("new owner"));
    await applied.promise;
    await expect(steered).resolves.toEqual({ outcome: "injected" });
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
        .map((n) => n.update),
    ).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "old owner" },
      },
    ]);
    // A second identical instruction has its own identity, even during the first lease.
    p.setPrompt((request) => {
      p.reply(request);
      p.emit({
        type: "message_start",
        message: {
          role: "custom",
          customType: "lody-steer",
          details: { steerId: "steer-2" },
          content: "change direction",
        },
      });
      p.emit(text("second owner"));
      p.finish();
    });
    const second = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
      sessionId: prompt.sessionId,
      steerId: "steer-2",
      prompt: [{ type: "text", text: "change direction" }],
    });
    released.resolve();
    await expect(second).resolves.toEqual({ outcome: "injected" });
    expect(applications).toEqual(["steer-1", "steer-2"]);
    await expect(done).resolves.toEqual({ stopReason: "end_turn" });
    expect(
      p.updates.some(
        (n) =>
          n.update.sessionUpdate === "agent_message_chunk" &&
          n.update.content.type === "text" &&
          n.update.content.text === "new owner",
      ),
    ).toBe(true);
    p.close();
  });

  it("preserves an idle refusal arriving after settlement so the host can requeue", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await p.accepted.promise;
    p.setPrompt((request) => {
      p.finish();
      p.emit({
        type: "extension_ui_request",
        method: "notify",
        message:
          "lody-rpc:" +
          JSON.stringify({ type: "lody_steer_refused", steerId: "late" }),
      });
      p.reply(request);
    });
    await expect(
      p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
        sessionId: prompt.sessionId,
        steerId: "late",
        prompt: prompt.prompt,
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await done;
    p.close();
  });

  it("clears a steer stranded at natural settlement before allowing the next prompt", async () => {
    const p = peer();
    await start(p);
    let stranded = true;
    p.setClearQueue((request) => {
      stranded = false;
      p.reply(request, {});
    });
    const done = p.client.prompt(prompt);
    await p.accepted.promise;
    const queued = deferred();
    p.setPrompt((request) => {
      p.reply(request);
      queued.resolve();
    });
    const steer = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
      sessionId: prompt.sessionId,
      steerId: "settlement-race",
      prompt: prompt.prompt,
    });
    const rejected = expect(steer).rejects.toMatchObject({ code: -32600 });
    await queued.promise;
    p.finish();
    await done;
    await rejected;
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.emit(text(stranded ? "old steer" : "new prompt"));
      p.finish();
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(
      p.updates.findLast(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toMatchObject({
      update: { content: { text: "new prompt" } },
    });
    p.close();
  });

  it.each([false, true])(
    "classifies cancelled steer after abort drains (applied=%s)",
    async (applied) => {
      const p = peer();
      await start(p);
      const done = p.client.prompt(prompt);
      await p.accepted.promise;
      const queued = deferred();
      const notifications: unknown[] = [];
      p.host.extension = async (_method, params) => {
        notifications.push(params);
      };
      p.setPrompt((request) => {
        p.reply(request);
        queued.resolve();
      });
      const steer = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
        sessionId: prompt.sessionId,
        steerId: "cancel-race",
        prompt: prompt.prompt,
      });
      const result = steer.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await queued.promise;
      p.setAbort((request) => {
        if (applied)
          p.emit({
            type: "message_start",
            message: {
              role: "custom",
              customType: "lody-steer",
              details: { steerId: "cancel-race" },
            },
          });
        p.finish();
        p.reply(request);
      });
      await p.client.cancel({ sessionId: prompt.sessionId });
      if (applied) {
        expect(await result).toMatchObject({ value: { outcome: "injected" } });
        expect(notifications).toEqual([
          { sessionId: prompt.sessionId, steerId: "cancel-race" },
        ]);
      } else {
        expect(await result).toMatchObject({ error: { code: -32600 } });
        expect(notifications).toEqual([]);
      }
      await expect(done).resolves.toEqual({ stopReason: "cancelled" });
      p.close();
    },
  );

  it.each(["cancel", "eof"] as const)(
    "settles pending steer on %s without applying it to a later turn",
    async (reason) => {
      const p = peer();
      await start(p);
      const done = p.client.prompt(prompt);
      void done.catch(() => undefined);
      await p.promptReceived.promise;
      await p.accepted.promise;
      const queued = deferred();
      p.setPrompt((request) => {
        p.reply(request);
        queued.resolve();
      });
      const steer = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
        sessionId: prompt.sessionId,
        steerId: "pending",
        prompt: prompt.prompt,
      });
      const rejected = expect(steer).rejects.toThrow();
      await queued.promise;
      if (reason === "cancel") {
        await p.client.cancel({ sessionId: prompt.sessionId });
        await done;
        p.close();
      } else {
        p.close();
        await expect(done).rejects.toThrow("closed");
      }
      await rejected;
    },
  );

  it("keeps tool generation distinct from execution, reads cumulative session usage, and waits through retry to settled", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end" },
    });
    p.emit({
      type: "tool_execution_start",
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "a.ts", oldText: "old", newText: "new" },
    });
    p.emit({
      type: "tool_execution_end",
      toolCallId: "edit-1",
      toolName: "edit",
      isError: false,
      result: { content: [{ type: "text", text: "edited" }] },
    });
    p.emit({ ...text("first"), usage });
    p.emit({ ...text(" attempt"), usage });
    p.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "retryable",
        usage,
      },
    });
    p.emit({ type: "agent_end", willRetry: true });
    p.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "retryable",
    });
    p.emit({ type: "message_start", message: { role: "assistant" } });
    p.emit(text("recovered"));
    p.emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", usage },
    });
    p.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    p.emit({ type: "compaction_start", reason: "threshold" });
    p.emit({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "summary request failed",
    });
    p.emit({
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "threshold",
    });
    p.emit({ type: "summarization_retry_finished" });
    p.emit({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 3000, estimatedTokensAfter: 300 },
      aborted: false,
      willRetry: false,
    });
    p.finish();
    await expect(done).resolves.toEqual({ stopReason: "end_turn" });
    const history = p.updates.filter(
      (n) =>
        n.update.sessionUpdate !== "usage_update" &&
        !n.update._meta?.lody?.activity &&
        n.update.sessionUpdate !== "config_option_update",
    );
    expect(history.map((n) => n.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "agent_message_chunk",
    ]);
    expect(history[0]?.update).toMatchObject({
      kind: "edit",
      rawInput: {
        file_path: resolve("/work", "a.ts"),
        old_string: "old",
        new_string: "new",
      },
      locations: [{ path: resolve("/work", "a.ts") }],
    });
    expect(history[1]?.update).toMatchObject({
      status: "completed",
      rawOutput: { content: [{ type: "text", text: "edited" }] },
    });
    expect(p.usages.at(-1)?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 2,
      costUSD: 0.02,
    });
    const activities = p.updates.filter((n) => n.update._meta?.lody?.activity);
    expect(
      activities.map((n) => [
        n.update.sessionUpdate,
        "status" in n.update && n.update.status,
      ]),
    ).toEqual([
      ["tool_call", "in_progress"],
      ["tool_call_update", "completed"],
      ["tool_call", "in_progress"],
      ["tool_call", "in_progress"],
      ["tool_call_update", "completed"],
      ["tool_call_update", "completed"],
    ]);
    expect(activities[2]?.update._meta?.lody?.activity).toMatchObject({
      kind: "context_compaction",
      automatic: true,
    });
    p.close();
  });

  it.each(["before", "after", "handled", "model-error"])(
    "keeps extension diagnostics separate from the result: %s",
    async (phase) => {
      const p = peer();
      await start(p);
      const diagnostic = () =>
        p.emit({
          type: "extension_error",
          event: phase === "before" ? "input" : "agent_end",
          error: "Extension callback failed",
        });
      p.setPrompt((request) => {
        if (phase === "before" || phase === "handled") diagnostic();
        if (phase === "handled") {
          p.reply(request);
          return;
        }
        p.emit({ type: "agent_start" });
        p.emit({ type: "message_start", message: { role: "assistant" } });
        p.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: phase === "model-error" ? "error" : "stop",
            errorMessage: "Model failed",
          },
        });
        if (phase === "after" || phase === "model-error") diagnostic();
        p.finish();
        p.reply(request);
      });
      const result = p.client.prompt(prompt);
      if (phase === "model-error")
        await expect(result).rejects.toThrow("Model failed");
      else await expect(result).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        p.updates.map(({ update }) => update._meta?.lody?.notice),
      ).toContainEqual({
        level: "warning",
        message: "Extension callback failed",
        source: "pi",
      });
      p.setPrompt((request) => {
        p.emit({ type: "agent_start" });
        p.reply(request);
        p.finish();
      });
      await expect(p.client.prompt(prompt)).resolves.toEqual({
        stopReason: "end_turn",
      });
      p.close();
    },
  );

  it("reports handled input without misclassifying errors or empty model runs", async () => {
    const p = peer();
    await start(p);
    const notices = () =>
      p.updates.flatMap((notification) => {
        const notice = notification.update._meta?.lody?.notice;
        return notice ? [notice] : [];
      });
    p.setPrompt((request) => p.reply(request));
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(notices()).toEqual([
      {
        level: "info",
        message: "Pi processed this input without starting a model turn.",
        source: "pi",
      },
    ]);
    p.setPrompt((request) => p.reply(request, undefined, "No API key found"));
    await expect(p.client.prompt(prompt)).rejects.toThrow("No API key found");
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.finish();
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(notices()).toHaveLength(1);
    p.setPrompt((request) => {
      p.emit({
        type: "extension_error",
        event: "command",
        error: "Command failed",
      });
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).rejects.toThrow("Command failed");
    expect(notices()).toHaveLength(1);
    p.close();
  });

  it("fails a settled model error even after partial text, but allows a later prompt", async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.emit(text("partial"));
      p.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 1,
        delayMs: 100,
        errorMessage: "Model unavailable",
      });
      p.emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Model unavailable",
        },
      });
      p.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "Model unavailable",
      });
      p.finish();
    });
    await expect(p.client.prompt(prompt)).rejects.toThrow("Model unavailable");
    expect(
      p.updates.find((n) => n.update.sessionUpdate === "tool_call_update")
        ?.update,
    ).toMatchObject({
      status: "failed",
      _meta: { lody: { activity: { failureReason: "Model unavailable" } } },
    });
    p.setPrompt((request) => p.reply(request));
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    p.close();
  });

  it("clears queues before abort and rejects concurrent prompts", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await expect(p.client.prompt(prompt)).rejects.toThrow("active prompt");
    await p.client.cancel({ sessionId: prompt.sessionId });
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    expect(
      p.commands
        .filter((c) => c.type === "clear_queue" || c.type === "abort")
        .map((c) => c.type),
    ).toEqual(["clear_queue", "abort"]);
    p.close();
  });

  it("holds cancel and the next input behind the same settlement barrier", async () => {
    const p = peer();
    await start(p);
    const stats = deferred<Record<string, unknown>>();
    p.setStats(stats.resolve);
    const done = p.client.prompt(prompt);
    await p.accepted.promise;
    const cancelled = p.client.cancel({ sessionId: prompt.sessionId });
    const repeated = p.client.cancel({ sessionId: prompt.sessionId });
    const request = await stats.promise;
    p.setPrompt((request) => p.reply(request));
    const next = p.client.prompt(prompt);
    // If admission rejects while stats are pending, this assertion fails even though
    // the old run has already reached Pi's settled event.
    const nextResult = expect(next).resolves.toEqual({
      stopReason: "end_turn",
    });
    p.reply(request, {
      tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
      cost: 0.02,
    });
    p.setStats((request) => p.reply(request));
    await Promise.all([cancelled, repeated, nextResult]);
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    expect(p.commands.filter((c) => c.type === "abort")).toHaveLength(1);
    p.setStats((request) => p.reply(request));
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    p.close();
  });

  it("cancels input during initial state lookup without dispatching a model request", async () => {
    const p = peer();
    await start(p);
    const accepted = deferred<Record<string, unknown>>();
    p.setState((request) => accepted.resolve(request));
    const idleAbort = deferred();
    p.setAbort((request) => {
      p.reply(request);
      idleAbort.resolve();
    });
    const done = p.client.prompt(prompt);
    const request = await accepted.promise;
    const cancelled = p.client.cancel({ sessionId: prompt.sessionId });
    await idleAbort.promise;
    p.setState((request) => p.reply(request, p.state));
    p.reply(request, p.state);
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    await cancelled;
    expect(p.commands.some((command) => command.type === "prompt")).toBe(false);
    p.close();
  });

  it("rejects an in-flight run on EOF rather than treating the acknowledgement as completion", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.close();
    await expect(done).rejects.toThrow("closed");
  });

  it("resumes exactly the native file and refreshes the thinking ladder after switching models", async () => {
    const p = peer();
    await start(p);
    await p.client.resumeSession({
      sessionId: prompt.sessionId,
      cwd: "/work",
      mcpServers: [],
    });
    expect(p.commands.find((c) => c.type === "switch_session")).toMatchObject({
      sessionPath: prompt.sessionId,
    });
    const response = await p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: "model",
      value: "fixture/two",
    });
    expect(
      response.configOptions.find((option) => option.id === "thinking"),
    ).toMatchObject({
      currentValue: "off",
      options: [{ name: "off", value: "off" }],
    });
    await expect(
      p.client.setSessionConfigOption({
        sessionId: prompt.sessionId,
        configId: "thinking",
        value: "high",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      p.client.resumeSession({
        sessionId: "legacy-pi-acp",
        cwd: "/work",
        mcpServers: [],
      }),
    ).rejects.toThrow("native session file");
    p.close();
  });

  it("compacts with custom instructions and reports activity plus the final usage snapshot", async () => {
    const p = peer();
    await start(p);
    p.setCompact((request) => {
      p.emit({ type: "compaction_start", reason: "manual" });
      p.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        result: { tokensBefore: 2000, estimatedTokensAfter: 200 },
      });
      p.reply(request, { summary: "synthetic" });
    });
    p.setStats((request) =>
      p.reply(request, {
        tokens: { input: 50, output: 20, cacheRead: 4, cacheWrite: 2 },
        cost: 0.03,
        contextUsage: { tokens: null, contextWindow: 4096 },
      }),
    );
    await expect(
      p.client.prompt({
        ...prompt,
        prompt: [{ type: "text", text: "/compact keep the test results" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(p.commands.find((c) => c.type === "compact")).toMatchObject({
      customInstructions: "keep the test results",
    });
    const activity = p.updates.filter((n) => n.update._meta?.lody?.activity);
    expect(activity.map((n) => n.update)).toMatchObject([
      {
        sessionUpdate: "tool_call",
        status: "in_progress",
        _meta: {
          lody: { activity: { kind: "context_compaction", automatic: false } },
        },
      },
      {
        sessionUpdate: "tool_call_update",
        status: "completed",
        _meta: {
          lody: { activity: { usedTokensBefore: 2000, usedTokensAfter: 200 } },
        },
      },
    ]);
    expect(p.usages.at(-1)?.usage.costUSD).toBe(0.03);
    expect(
      p.updates.filter((n) => n.update.sessionUpdate === "usage_update"),
    ).toEqual([]);
    p.close();
  });

  it("reports failed and cancelled compaction without success text and can continue", async () => {
    const p = peer();
    await start(p);
    const compact = {
      ...prompt,
      prompt: [{ type: "text" as const, text: "/compact" }],
    };
    p.setCompact((request) => {
      p.emit({ type: "compaction_start", reason: "manual" });
      p.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        errorMessage: "Summary unavailable",
        willRetry: false,
      });
      p.reply(request, undefined, "Summary unavailable");
    });
    await expect(p.client.prompt(compact)).rejects.toThrow(
      "Summary unavailable",
    );
    const entered = deferred<Record<string, unknown>>();
    p.setCompact(entered.resolve);
    const done = p.client.prompt(compact);
    const command = await entered.promise;
    p.setAbort((request) => {
      p.emit({ type: "compaction_start", reason: "manual" });
      p.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: true,
        willRetry: false,
      });
      p.reply(command, undefined, "Compaction cancelled");
      p.reply(request);
    });
    await p.client.cancel({ sessionId: prompt.sessionId });
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    expect(
      p.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk"),
    ).toEqual([]);
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "tool_call_update")
        .map((n) => n.update),
    ).toMatchObject([
      {
        status: "failed",
        _meta: { lody: { activity: { failureReason: "Summary unavailable" } } },
      },
      {
        status: "failed",
        _meta: { lody: { activity: { failureReason: "Cancelled" } } },
      },
    ]);
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.emit({ type: "compaction_start", reason: "overflow" });
      p.emit({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: true,
        errorMessage: "Automatic summary unavailable",
      });
      p.emit(text("Pi continued after the failed automatic summary"));
      p.finish();
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "tool_call_update")
        .at(-1)?.update,
    ).toMatchObject({
      status: "failed",
      _meta: {
        lody: {
          activity: {
            automatic: true,
            failureReason: "Automatic summary unavailable",
          },
        },
      },
    });
    p.close();
  });

  it("advertises usage and refreshes authoritative snapshots across resume and model changes", async () => {
    const p = peer();
    let input = 20;
    p.setStats((request) =>
      p.reply(request, {
        tokens: { input, output: 10, cacheRead: 4, cacheWrite: 2 },
        cost: 0.02,
        contextUsage: {
          tokens: 64,
          contextWindow: p.state.model.contextWindow,
        },
      }),
    );
    await start(p);
    expect(initializeResponse().agentCapabilities?._meta?.lody?.usage).toEqual({
      version: 1,
    });
    await p.client.resumeSession({
      sessionId: prompt.sessionId,
      cwd: "/work",
      mcpServers: [],
    });
    input = 30;
    await p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: "model",
      value: "fixture/two",
    });
    expect(p.usages.map((value) => value.usage.inputTokens)).toEqual([
      20, 20, 30,
    ]);
    // An explicit empty breakdown prevents a host from assigning the cumulative
    // multi-model and compaction total to whichever model is selected now.
    expect(p.usages.map((value) => value.modelUsage)).toEqual([{}, {}, {}]);
    expect(p.updates.at(-1)?.update).toEqual({
      sessionUpdate: "usage_update",
      used: 64,
      size: 4096,
    });
    p.close();
  });

  it("cancels a pending extension dialog before its host answers and ignores the late answer", async () => {
    const p = peer();
    await start(p);
    const seen = deferred();
    const answer = deferred<acp.CreateElicitationResponse>();
    p.host.question = async () => {
      seen.resolve();
      return answer.promise;
    };
    let command!: Record<string, unknown>;
    p.setPrompt((request) => {
      command = request;
      p.emit({
        type: "extension_ui_request",
        id: "held",
        method: "input",
        title: "Waiting",
      });
    });
    const done = p.client.prompt(prompt);
    await seen.promise;
    const cancelled = p.client.cancel({ sessionId: prompt.sessionId });
    await p.questionAnswered.promise;
    const cancelledBeforeAnswer = p.replies.some(
      (r) => r.id === "held" && r.cancelled === true,
    );
    answer.resolve({ action: "accept", content: { answer: "too late" } });
    await p.questionAnswered.promise;
    p.reply(command);
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    await cancelled;
    expect(cancelledBeforeAnswer).toBe(true);
    expect(p.replies.filter((r) => r.id === "held")).toEqual([
      { type: "extension_ui_response", id: "held", cancelled: true },
    ]);
    p.close();
  });

  it("answers extension dialogs without blocking the wire, and rejects startup questions", async () => {
    const p = peer();
    await start(p);
    p.emit({
      type: "extension_ui_request",
      id: "startup",
      method: "input",
      title: "Before prompt",
    });
    await expect(p.questionAnswered.promise).resolves.toMatchObject({
      id: "startup",
      cancelled: true,
    });
    p.close();
    const active = peer();
    await start(active);
    const done = active.client.prompt(prompt);
    await active.promptReceived.promise;
    active.emit({
      type: "extension_ui_request",
      id: "in-turn",
      method: "select",
      title: "Choose",
      options: ["chosen", "other"],
    });
    await expect(active.questionAnswered.promise).resolves.toMatchObject({
      id: "in-turn",
      value: "chosen",
    });
    active.emit(text("working"));
    active.finish();
    await done;
    expect(
      active.updates.some(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(true);
    active.close();
  });
});
