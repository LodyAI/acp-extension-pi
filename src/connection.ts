import path from "node:path";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

import {
  LODY_EXTENSION_METHODS,
  type LodyActivityMeta,
  type SessionUsageUpdate,
} from "acp-extension-core";
import type { AgentConnection, PiStream } from "./types.js";
import { PiTransport } from "./transport.js";
import { PI_RPC_VERSION } from "./version.js";

const modelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().nonnegative(),
});
const stateSchema = z.object({
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  model: modelSchema.nullish(),
  thinkingLevel: z.string(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number(),
});
const contentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string(),
    }),
  ]),
);
const statsSchema = z.object({
  tokens: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  }),
  cost: z.number().nonnegative(),
  contextUsage: z
    .object({
      tokens: z.number().nonnegative().nullable(),
      contextWindow: z.number().nonnegative(),
    })
    .optional(),
});
const startupConfigSchema = z.object({
  lody: z.object({
    sessionConfig: z.object({
      configOptionValues: z.record(
        z.string(),
        z.union([z.string(), z.boolean()]),
      ),
    }),
  }),
});
const questionSchema = z.object({
  id: z.string(),
  method: z.string(),
  title: z.string().optional(),
  message: z.string().optional(),
  prefill: z.string().optional(),
  options: z.array(z.string()).optional(),
  timeout: z.number().nonnegative().optional(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A process may exit while the caller is still awaiting the command acknowledgement.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
type Run = ReturnType<typeof deferred<acp.PromptResponse>> & {
  activities: Map<string, { id: string; meta: LodyActivityMeta }>;
  finished: ReturnType<typeof deferred<void>>;
  cancellation?: Promise<void>;
  changed: ReturnType<typeof deferred<void>>;
  started: boolean;
  settled: boolean;
  cancelled: boolean;
  error?: string;
  stopReason?: "max_tokens";
};
type Host = {
  configureMcp: (servers: acp.McpServer[]) => Promise<void>;
  update: (notification: acp.SessionNotification) => Promise<void>;
  extension: (method: string, params: Record<string, unknown>) => Promise<void>;
  usage: (usage: SessionUsageUpdate) => void;
  question: (
    request: acp.CreateElicitationRequest,
  ) => Promise<acp.CreateElicitationResponse>;
};

/** Translates the ACP control contract to the pinned Pi JSONL runtime. */
export class PiRpcConnection implements AgentConnection {
  private readonly rpc: PiTransport;
  private sessionId = "";
  private cwd = "";
  private active?: Run;
  private configuring = false;
  private readonly questions = new Map<string, () => Promise<void>>();
  private steerCommand = "";
  private pendingSteer?: {
    id: string;
    run: Run;
    applied: ReturnType<typeof deferred<void>>;
  };

  constructor(
    stream: PiStream,
    private readonly host: Host,
  ) {
    this.rpc = new PiTransport(
      stream,
      (event) => this.event(event),
      (error) => {
        this.questions.clear();
        this.active?.reject(error);
        this.pendingSteer?.applied.reject(error);
      },
    );
  }

  initialize: AgentConnection["initialize"] = async () => {
    await this.rpc.request("get_state");
    await this.rpc.drain();
    if (!this.steerCommand)
      throw new Error("Required Lody Pi extension did not initialize");
    return initializeResponse();
  };

  newSession: AgentConnection["newSession"] = async (request) => {
    return this.configure(async () => {
      this.cwd = request.cwd;
      await this.host.configureMcp(request.mcpServers ?? []);
      this.steerCommand = "";
      const result = z
        .object({ cancelled: z.boolean() })
        .parse(await this.rpc.request("new_session"));
      if (result.cancelled)
        throw new Error("Pi extension cancelled session creation");
      await this.initialize({ protocolVersion: 1 });
      return this.prepare(request._meta);
    }, true);
  };

  resumeSession: AgentConnection["resumeSession"] = async (request) => {
    return this.configure(async () => {
      this.cwd = request.cwd;
      if (
        !path.isAbsolute(request.sessionId) ||
        !request.sessionId.endsWith(".jsonl")
      ) {
        throw new Error(
          "Pi resume requires its native session file; pi-acp ids cannot be migrated automatically",
        );
      }
      await this.host.configureMcp(request.mcpServers ?? []);
      this.steerCommand = "";
      const result = z.object({ cancelled: z.boolean() }).parse(
        await this.rpc.request("switch_session", {
          sessionPath: request.sessionId,
        }),
      );
      if (result.cancelled)
        throw new Error("Pi extension cancelled session resume");
      await this.initialize({ protocolVersion: 1 });
      const response = await this.prepare(request._meta);
      if (response.sessionId !== request.sessionId)
        throw new Error("Pi resumed a different session file");
      return response;
    }, true);
  };

  private async prepare(meta: unknown): Promise<acp.NewSessionResponse> {
    const config = startupConfigSchema.safeParse(meta);
    if (config.success) {
      const values = config.data.lody.sessionConfig.configOptionValues;
      // Model first: the supported thinking ladder belongs to the selected model.
      for (const id of ["model", "thinking"]) {
        const value = values[id];
        if (typeof value === "string") await this.setOption(id, value);
      }
    }
    const state = await this.readState();
    if (!state.sessionFile)
      throw new Error("Pi did not provide a persistent session file");
    this.sessionId = state.sessionFile;
    const configOptions = await this.configOptions();
    await this.reportUsage();
    return { sessionId: this.sessionId, configOptions };
  }

  private async configOptions(
    observedState?: z.infer<typeof stateSchema>,
  ): Promise<acp.SessionConfigOption[]> {
    const [rawState, rawModels, rawLevels] = await Promise.all([
      observedState ?? this.readState(),
      this.rpc.request("get_available_models"),
      this.rpc.request("get_available_thinking_levels"),
    ]);
    const state = rawState;
    if (!state.sessionFile)
      throw new Error("Pi did not provide a persistent session file");
    const models = z
      .object({ models: z.array(modelSchema) })
      .parse(rawModels).models;
    const levels = z
      .object({ levels: z.array(z.string()) })
      .parse(rawLevels).levels;
    if (!state.model || models.length === 0)
      throw new Error(
        "Pi has no configured model. Run pi /login on this machine or add provider API keys to the agent environment.",
      );
    return [
      ...(state.model
        ? [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select" as const,
              currentValue: `${state.model.provider}/${state.model.id}`,
              options: models.map((model) => ({
                value: `${model.provider}/${model.id}`,
                name: `${model.name} (${model.provider})`,
              })),
            },
          ]
        : []),
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: state.thinkingLevel,
        options: levels.map((value) => ({ value, name: value })),
      },
    ];
  }

  private async setOption(id: string, value: string): Promise<void> {
    if (id === "model") {
      const models = z
        .object({ models: z.array(modelSchema) })
        .parse(await this.rpc.request("get_available_models")).models;
      const model = models.find(
        (candidate) => `${candidate.provider}/${candidate.id}` === value,
      );
      if (!model) throw new Error(`Pi model is unavailable: ${value}`);
      await this.rpc.request("set_model", {
        provider: model.provider,
        modelId: model.id,
      });
    } else if (id === "thinking") {
      const { levels } = z
        .object({ levels: z.array(z.string()) })
        .parse(await this.rpc.request("get_available_thinking_levels"));
      if (!levels.includes(value))
        throw new Error(
          `Pi thinking level is unavailable for this model: ${value}`,
        );
      await this.rpc.request("set_thinking_level", { level: value });
    } else throw new Error(`Unsupported Pi configuration option: ${id}`);
  }

  setSessionConfigOption: AgentConnection["setSessionConfigOption"] = async (
    request,
  ) => {
    this.assertSession(request.sessionId);
    return this.configure(async () => {
      await this.readState();
      if (typeof request.value !== "string")
        throw new Error("Pi configuration requires a select value");
      await this.setOption(request.configId, request.value);
      const configOptions = await this.configOptions();
      await this.reportUsage();
      return { configOptions };
    });
  };

  prompt: AgentConnection["prompt"] = async (request) => {
    await this.waitForSettledRun();
    this.assertSession(request.sessionId);
    this.assertIdle();
    const { message, images } = this.promptContent(request.prompt);
    const run: Run = {
      ...deferred<acp.PromptResponse>(),
      activities: new Map(),
      finished: deferred<void>(),
      changed: deferred<void>(),
      started: false,
      settled: false,
      cancelled: false,
    };
    this.active = run;
    try {
      await this.readState();
      await this.rpc.drain();
      this.assertReady();
      if (message.trim() === "/stats" && images.length === 0) {
        const stats = await this.reportUsage();
        if (!stats) run.error = "Pi session usage is unavailable";
        if (stats && !run.cancelled)
          await this.update({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Pi session usage: ${stats.tokens.input} input, ${stats.tokens.output} output, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write tokens; $${stats.cost.toFixed(6)}.`,
            },
          });
        this.finishRun(run);
      } else if (
        /^\/compact(?:\s|$)/.test(message.trim()) &&
        images.length === 0
      ) {
        try {
          await this.rpc.request("compact", {
            customInstructions:
              message.trim().slice("/compact".length).trim() || undefined,
          });
        } catch (error) {
          run.error = error instanceof Error ? error.message : String(error);
        } finally {
          await this.rpc.drain();
          await this.reportUsage();
        }
        if (!run.cancelled && !run.error)
          await this.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Context compacted." },
          });
        this.finishRun(run);
      } else {
        await this.rpc.request("prompt", {
          message,
          ...(images.length ? { images } : {}),
        });
        // Pi input hooks / extension commands can handle input without starting an agent run.
        // Query only after acceptance, then drain earlier events. Never use an idle snapshot to
        // finish a run that started: retry and compaction gaps also look idle.
        await this.waitForNativeCompletion(run);
        const pending = this.pendingSteer;
        if (pending && !run.cancelled) {
          await this.rpc.request("clear_queue");
          await this.rpc.drain();
          if (this.pendingSteer === pending && !run.cancelled)
            pending.applied.reject(
              acp.RequestError.invalidRequest(
                undefined,
                "Pi settled before steer delivery",
              ),
            );
        }
        await this.refreshConfigOptions();
        await this.reportUsage();
        if (!run.started && !run.cancelled && !run.error)
          await this.notice(
            "Pi processed this input without starting a model turn.",
          );
        this.finishRun(run);
      }
      return await run.promise;
    } finally {
      await run.cancellation?.catch(() => undefined);
      for (const key of run.activities.keys())
        await this.endActivity(
          run,
          key,
          run.cancelled ? "Cancelled" : "Pi ended without an activity result",
        ).catch(() => undefined);
      await this.cancelQuestions().catch(() => undefined);
      if (this.active === run) this.active = undefined;
      run.finished.resolve();
    }
  };

  private finishRun(run: Run): void {
    if (run.cancelled) run.resolve({ stopReason: "cancelled" });
    else if (run.error) run.reject(new Error(run.error));
    else run.resolve({ stopReason: run.stopReason ?? "end_turn" });
  }

  private async waitForNativeCompletion(run: Run) {
    // Settlement belongs to Pi. A callback can start more work before the old
    // settled event reaches RPC, so require both settlement and current idle state.
    for (;;) {
      const changed = run.changed;
      const state = await this.readState();
      await this.rpc.drain();
      this.assertReady();
      if (
        (!run.started || run.settled) &&
        !state.isStreaming &&
        !state.isCompacting &&
        state.pendingMessageCount === 0
      )
        return;
      await Promise.race([changed.promise, run.promise]);
    }
  }

  private async refreshConfigOptions(): Promise<void> {
    // Identity/transport failures remain fatal. Only the display refresh is optional.
    const state = await this.readState();
    let configOptions: acp.SessionConfigOption[];
    try {
      configOptions = await this.configOptions(state);
    } catch (error) {
      this.rpc.assertOpen();
      process.stderr.write(
        `Pi configuration refresh failed: ${String(error)}\n`,
      );
      return;
    }
    await this.update({ sessionUpdate: "config_option_update", configOptions });
  }

  cancel: AgentConnection["cancel"] = async (request) => {
    this.assertSession(request.sessionId);
    const run = this.active;
    if (!run) return;
    run.cancelled = true;
    await this.cancelRun(run);
    await run.finished.promise;
  };

  private cancelRun(run: Run, afterPreflight = false): Promise<void> {
    if (!run.cancellation || afterPreflight)
      run.cancellation = (run.cancellation ?? Promise.resolve()).then(() =>
        this.abort(),
      );
    return run.cancellation;
  }

  private async abort(): Promise<void> {
    const pending = this.pendingSteer;
    try {
      await this.cancelQuestions();
      // clear_queue alone cannot see messages already drained into Pi's agent loop.
      // abort waits for idle; drain observes their message_start before classifying delivery.
      await this.rpc.request("clear_queue");
      await this.rpc.request("abort");
      await this.rpc.drain();
      if (pending && this.pendingSteer === pending)
        pending.applied.reject(
          acp.RequestError.invalidRequest(
            undefined,
            "Pi steer cancelled before delivery",
          ),
        );
    } catch (error) {
      pending?.applied.reject(
        error instanceof Error ? error : new Error("Pi cancellation failed"),
      );
      throw error;
    }
  }

  private promptContent(blocks: acp.ContentBlock[]) {
    const text: string[] = [];
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          text.push(block.text);
          break;
        case "image":
          images.push({
            type: "image",
            data: block.data,
            mimeType: block.mimeType,
          });
          break;
        case "resource_link":
          text.push(`${block.name}: ${block.uri}`);
          break;
        case "resource":
          if ("text" in block.resource)
            text.push(`${block.resource.uri}\n${block.resource.text}`);
          else
            throw new Error(
              "Pi does not support embedded binary resources; attach an image or a file link",
            );
          break;
        default:
          throw new Error(`Pi does not support prompt content: ${block.type}`);
      }
    }
    return { message: text.join("\n\n"), images };
  }

  private update(update: acp.SessionNotification["update"]): Promise<void> {
    if (!this.sessionId || !this.steerCommand) return Promise.resolve();
    return this.host.update({ sessionId: this.sessionId, update });
  }

  private notice(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ) {
    return this.update({
      sessionUpdate: "session_info_update",
      _meta: { lody: { notice: { level, message, source: "pi" } } },
    });
  }

  private observeSession(file: string | undefined): void {
    if (this.sessionId && file !== this.sessionId) {
      this.sessionId = "";
      this.steerCommand = "";
      const error = new Error(
        "Pi changed its native session; explicitly create or resume a session",
      );
      this.active?.reject(error);
      this.pendingSteer?.applied.reject(error);
      throw error;
    }
  }

  private async readState() {
    const state = stateSchema.parse(await this.rpc.request("get_state"));
    this.observeSession(state.sessionFile);
    return state;
  }

  private assertReady(): void {
    if (!this.steerCommand)
      throw new Error("Required Lody Pi extension did not initialize");
  }

  private async event(event: Record<string, unknown>): Promise<void> {
    if (
      event.type === "extension_ui_request" &&
      event.method === "notify" &&
      typeof event.message === "string" &&
      event.message.startsWith("lody-rpc:")
    ) {
      event = z
        .object({
          type: z.enum([
            "lody_steer_ready",
            "lody_steer_refused",
            "lody_not_ready",
          ]),
          version: z.number().optional(),
          steerId: z.string().optional(),
          command: z.string().optional(),
          sessionFile: z.string().optional(),
        })
        .parse(JSON.parse(event.message.slice("lody-rpc:".length)));
    }
    if (event.type === "lody_steer_ready") {
      // Lifecycle events precede any output from the replacement runtime.
      try {
        this.observeSession(
          typeof event.sessionFile === "string" ? event.sessionFile : undefined,
        );
      } catch {
        return;
      }
      this.steerCommand =
        event.version === 1 &&
        typeof event.command === "string" &&
        /^[a-zA-Z0-9_-]+$/.test(event.command)
          ? event.command
          : "";
      return;
    }
    if (event.type === "lody_not_ready") {
      this.steerCommand = "";
      this.pendingSteer?.applied.reject(
        new Error("Pi extension runtime stopped"),
      );
      await this.cancelQuestions();
      return;
    }
    if (event.type === "lody_steer_refused") {
      if (this.pendingSteer && event.steerId === this.pendingSteer.id)
        this.pendingSteer.applied.reject(
          acp.RequestError.invalidRequest(
            undefined,
            "Pi is idle; steer was not delivered",
          ),
        );
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "notify") {
        const notice = z
          .object({
            message: z.string(),
            notifyType: z.enum(["info", "warning", "error"]).optional(),
          })
          .parse(event);
        await this.notice(notice.message, notice.notifyType);
        return;
      }
      const request = questionSchema.parse(event);
      // Do not block the wire/notification queue on a human response.
      void this.question(request).catch(() => undefined);
      return;
    }
    if (
      event.type === "message_end" &&
      z.object({ role: z.string() }).parse(event.message).role === "custom"
    ) {
      const custom = z
        .object({
          customType: z.string(),
          display: z.boolean(),
          content: z.union([z.string(), contentSchema]),
        })
        .parse(event.message);
      // The driving ACP turn already owns steering text. Hidden custom context
      // is for Pi's model, not another visible transcript entry.
      if (custom.display && custom.customType !== "lody-steer") {
        const content =
          typeof custom.content === "string"
            ? [{ type: "text" as const, text: custom.content }]
            : custom.content;
        for (const block of content)
          await this.update({
            sessionUpdate: "agent_message_chunk",
            content: block,
          });
      }
      return;
    }
    const run = this.active;
    if (event.type === "extension_error" && (!run || run.settled)) {
      process.stderr.write(`Pi extension diagnostic: ${String(event.error)}\n`);
      return;
    }
    if (!run) return;
    // Pi creates cancellation controllers after asynchronous preflight. An early
    // abort may see idle; repeat it when either native operation actually starts.
    if (
      run.cancelled &&
      (event.type === "agent_start" || event.type === "compaction_start")
    )
      void this.cancelRun(run, true).catch((error: unknown) =>
        run.reject(
          error instanceof Error ? error : new Error("Pi cancellation failed"),
        ),
      );
    switch (event.type) {
      case "agent_start":
        run.started = true;
        run.settled = false;
        break;
      case "agent_settled": {
        if (!run.started) break;
        run.settled = true;
        break;
      }
      case "message_start": {
        const message = z
          .object({
            role: z.string(),
            customType: z.string().optional(),
            details: z.unknown().optional(),
          })
          .parse(event.message);
        const pending = this.pendingSteer;
        const identity = z
          .object({ steerId: z.string() })
          .safeParse(message.details);
        if (
          pending &&
          pending.run === run &&
          message.role === "custom" &&
          message.customType === "lody-steer" &&
          identity.success &&
          identity.data.steerId === pending.id
        ) {
          this.pendingSteer = undefined;
          pending.applied.resolve();
          // The existing host lease switches history ownership before any subsequent output.
          await this.host.extension(
            LODY_EXTENSION_METHODS.sessionSteerApplied,
            {
              sessionId: this.sessionId,
              steerId: pending.id,
            },
          );
        }
        if (message.role === "assistant") {
          run.error = undefined;
          run.stopReason = undefined;
          await this.readState();
        }
        break;
      }
      case "message_update": {
        const delta = z
          .object({ type: z.string(), delta: z.string().optional() })
          .parse(event.assistantMessageEvent);
        if (
          (delta.type === "text_delta" || delta.type === "thinking_delta") &&
          delta.delta
        ) {
          await this.update({
            sessionUpdate:
              delta.type === "text_delta"
                ? "agent_message_chunk"
                : "agent_thought_chunk",
            content: { type: "text", text: delta.delta },
          });
        }
        break;
      }
      case "message_end": {
        const message = z
          .object({
            role: z.string(),
            stopReason: z.string().optional(),
            errorMessage: z.string().optional(),
          })
          .parse(event.message);
        if (message.role !== "assistant") break;
        if (message.stopReason === "error")
          run.error = message.errorMessage ?? "Pi model request failed";
        if (message.stopReason === "aborted") run.cancelled = true;
        run.stopReason =
          message.stopReason === "length" ? "max_tokens" : undefined;
        // Pi owns validity, compaction boundaries and the matching context window.
        // Refresh between assistant messages as well as at final settlement.
        await this.reportUsage();
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        await this.tool(event);
        break;
      case "compaction_start":
        await this.startActivity(run, "compaction", "Compact context", {
          version: 1,
          kind: "context_compaction",
          automatic: event.reason !== "manual",
        });
        break;
      case "compaction_end": {
        const result = z
          .object({
            tokensBefore: z.number().nonnegative().optional(),
            estimatedTokensAfter: z.number().nonnegative().optional(),
          })
          .optional()
          .parse(event.result);
        await this.endActivity(
          run,
          "summaryRetry",
          event.aborted ? "Cancelled" : undefined,
        );
        await this.endActivity(
          run,
          "compaction",
          event.aborted
            ? "Cancelled"
            : typeof event.errorMessage === "string"
              ? event.errorMessage
              : !result
                ? "Compaction did not produce a summary"
                : undefined,
          {
            usedTokensBefore: result?.tokensBefore,
            usedTokensAfter: result?.estimatedTokensAfter,
          },
        );
        if (!run.started) {
          if (event.aborted) run.cancelled = true;
          else if (typeof event.errorMessage === "string")
            run.error = event.errorMessage;
        }
        break;
      }
      case "auto_retry_start":
      case "summarization_retry_scheduled":
        await this.startActivity(
          run,
          event.type === "auto_retry_start" ? "retry" : "summaryRetry",
          `${event.type === "auto_retry_start" ? "Model retry" : "Summary retry wait"} ${event.attempt}/${event.maxAttempts}`,
          { version: 1, kind: "retry", automatic: true },
        );
        break;
      case "auto_retry_end":
        await this.endActivity(
          run,
          "retry",
          event.success
            ? undefined
            : String(event.finalError ?? "Retry failed"),
        );
        break;
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        // This event ends the backoff, not the enclosing compaction operation.
        await this.endActivity(
          run,
          "summaryRetry",
          run.cancelled ? "Cancelled" : undefined,
        );
        break;
      case "extension_error": {
        const diagnostic = z
          .object({ event: z.string(), error: z.string() })
          .parse(event);
        // Pi acknowledges a handled command even when its handler throws. Ordinary
        // extension callbacks are diagnostics, not authority over the model result.
        if (diagnostic.event === "command" && !run.started) {
          run.error = diagnostic.error;
        } else {
          await this.notice(diagnostic.error, "warning");
        }
        break;
      }
    }
    if (
      typeof event.type === "string" &&
      [
        "agent_start",
        "agent_settled",
        "compaction_start",
        "compaction_end",
        "queue_update",
      ].includes(event.type)
    ) {
      run.changed.resolve();
      run.changed = deferred<void>();
    }
  }

  private async startActivity(
    run: Run,
    key: string,
    title: string,
    meta: LodyActivityMeta,
  ) {
    const existing = run.activities.get(key);
    const activity = existing ?? { id: `pi-${key}-${randomUUID()}`, meta };
    run.activities.set(key, activity);
    await this.update({
      sessionUpdate: existing ? "tool_call_update" : "tool_call",
      toolCallId: activity.id,
      title,
      kind: "other",
      status: "in_progress",
      _meta: { lody: { activity: meta } },
    });
  }

  private async endActivity(
    run: Run,
    key: string,
    failureReason?: string,
    details: Partial<LodyActivityMeta> = {},
  ) {
    const activity = run.activities.get(key);
    if (!activity) return;
    run.activities.delete(key);
    await this.update({
      sessionUpdate: "tool_call_update",
      toolCallId: activity.id,
      status: failureReason ? "failed" : "completed",
      _meta: {
        lody: {
          activity: {
            ...activity.meta,
            ...details,
            ...(failureReason ? { failureReason } : {}),
          },
        },
      },
    });
  }

  private async reportUsage() {
    const sessionId = this.sessionId;
    // Pi owns the cumulative session total, including compaction and native resume.
    // Never feed per-message snapshots into the host's session-snapshot channel.
    const parsed = statsSchema.safeParse(
      await this.rpc.request("get_session_stats").catch(() => {
        // An unavailable snapshot is optional; a failed connection is not,
        // including startup/configuration where there is no active prompt to reject.
        this.rpc.assertOpen();
        return undefined;
      }),
    );
    if (
      !parsed.success ||
      !sessionId ||
      sessionId !== this.sessionId ||
      !this.steerCommand
    )
      return;
    const { tokens, cost, contextUsage } = parsed.data;
    this.host.usage({
      sessionId,
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadInputTokens: tokens.cacheRead,
        cacheCreationInputTokens: tokens.cacheWrite,
        costUSD: cost,
      },
      // Pi totals include tool and summary usage without model provenance. Omitting
      // this field makes Lody attribute the entire total to the current model.
      modelUsage: {},
    });
    if (contextUsage?.tokens != null)
      await this.update({
        sessionUpdate: "usage_update",
        size: contextUsage.contextWindow,
        used: contextUsage.tokens,
      });
    return parsed.data;
  }

  private async tool(event: Record<string, unknown>): Promise<void> {
    const tool = z
      .object({
        type: z.string(),
        toolCallId: z.string(),
        toolName: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        result: z
          .object({ content: contentSchema, details: z.unknown().optional() })
          .optional(),
        partialResult: z.object({ content: contentSchema }).optional(),
        isError: z.boolean().optional(),
      })
      .parse(event);
    const start = tool.type === "tool_execution_start";
    const end = tool.type === "tool_execution_end";
    const args = tool.args ?? {};
    const file =
      typeof args.path === "string"
        ? path.resolve(this.cwd, args.path)
        : undefined;
    const kind: acp.ToolKind =
      tool.toolName === "bash"
        ? "execute"
        : tool.toolName === "read"
          ? "read"
          : ["edit", "write"].includes(tool.toolName)
            ? "edit"
            : ["grep", "find", "ls"].includes(tool.toolName)
              ? "search"
              : "other";
    const content = tool.result?.content ?? tool.partialResult?.content;
    const notification: acp.ToolCall = {
      toolCallId: tool.toolCallId,
      title: tool.toolName,
      kind,
      status: end ? (tool.isError ? "failed" : "completed") : "in_progress",
      ...(tool.args
        ? {
            rawInput: {
              ...args,
              ...(file ? { file_path: file } : {}),
              ...(typeof args.oldText === "string"
                ? { old_string: args.oldText }
                : {}),
              ...(typeof args.newText === "string"
                ? { new_string: args.newText }
                : {}),
            },
          }
        : {}),
      ...(file ? { locations: [{ path: file }] } : {}),
      ...(tool.result ? { rawOutput: tool.result } : {}),
      ...(content
        ? {
            content: content.map((block) => ({
              type: "content" as const,
              content: block,
            })),
          }
        : {}),
    };
    await this.update(
      start
        ? { ...notification, sessionUpdate: "tool_call" }
        : { ...notification, sessionUpdate: "tool_call_update" },
    );
  }

  private async question(
    request: z.infer<typeof questionSchema>,
  ): Promise<void> {
    if (!["select", "confirm", "input", "editor"].includes(request.method))
      return;
    const run = this.active;
    const cancel = () =>
      this.rpc.send({
        type: "extension_ui_response",
        id: request.id,
        cancelled: true,
      });
    if (
      !run ||
      run.settled ||
      run.cancelled ||
      !this.sessionId ||
      !this.steerCommand
    )
      return cancel();
    const options =
      request.method === "confirm" ? ["Yes", "No"] : request.options;
    const respond = async (fields: Record<string, unknown>): Promise<void> => {
      if (!this.questions.delete(request.id)) return;
      await this.rpc.send({
        type: "extension_ui_response",
        id: request.id,
        ...fields,
      });
    };
    this.questions.set(request.id, () => respond({ cancelled: true }));
    try {
      const response = await this.host.question({
        mode: "form",
        sessionId: this.sessionId,
        message: [
          request.title,
          request.message,
          request.prefill ? `Current text:\n${request.prefill}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        requestedSchema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              title: request.title ?? "Pi",
              ...(options
                ? {
                    oneOf: options.map((value) => ({
                      const: value,
                      title: value,
                    })),
                  }
                : {}),
            },
          },
          required: ["answer"],
        },
        _meta: {
          lody: {
            elicitation: {
              version: 1,
              autoResolveAfterSeconds:
                request.timeout === undefined ? null : request.timeout / 1000,
            },
          },
        },
      });
      if (
        this.active !== run ||
        run.cancelled ||
        run.settled ||
        response.action !== "accept"
      )
        return respond({ cancelled: true });
      const value = z
        .object({ answer: z.string() })
        .safeParse(response.content);
      const answer = value.success ? value.data.answer : undefined;
      if (typeof answer !== "string" || (options && !options.includes(answer)))
        return respond({ cancelled: true });
      await respond({
        ...(request.method === "confirm"
          ? { confirmed: answer === "Yes" }
          : { value: answer }),
      });
    } catch {
      await respond({ cancelled: true });
    }
  }

  private async cancelQuestions(): Promise<void> {
    await Promise.all([...this.questions.values()].map((cancel) => cancel()));
  }

  private async configure<T>(
    action: () => Promise<T>,
    replaceSession = false,
  ): Promise<T> {
    await this.waitForSettledRun();
    this.assertIdle();
    this.configuring = true;
    // A replacement can change Pi's durable identity before its ACK or config succeeds.
    // Never let an old ACP id address that new file, including after failure.
    if (replaceSession) this.sessionId = "";
    try {
      return await action();
    } catch (error) {
      if (replaceSession) this.sessionId = "";
      throw error;
    } finally {
      this.configuring = false;
    }
  }

  private assertIdle(): void {
    if (this.active || this.configuring)
      throw new Error(
        "Pi already has an active prompt or configuration operation",
      );
  }
  private async waitForSettledRun(): Promise<void> {
    const run = this.active;
    if (run?.settled || run?.cancelled) await run.finished.promise;
  }
  private assertSession(id: string): void {
    if (!this.sessionId || id !== this.sessionId)
      throw new Error("Pi session does not match the active session");
  }

  request: AgentConnection["request"] = async <T>(
    method: string,
    params?: unknown,
  ): Promise<T> => {
    if (method !== LODY_EXTENSION_METHODS.sessionSteer)
      throw new Error("Pi does not implement this ACP extension");
    const request = z
      .object({
        sessionId: z.string(),
        steerId: z.string(),
        prompt: z.array(
          z.union([
            z.object({ type: z.literal("text"), text: z.string() }),
            z.object({
              type: z.literal("image"),
              data: z.string(),
              mimeType: z.string(),
            }),
            z.object({
              type: z.literal("resource_link"),
              uri: z.string(),
              name: z.string(),
            }),
            z.object({
              type: z.literal("resource"),
              resource: z.object({ uri: z.string(), text: z.string() }),
            }),
          ]),
        ),
      })
      .parse(params);
    this.assertSession(request.sessionId);
    this.assertReady();
    const run = this.active;
    if (
      !run ||
      !run.started ||
      run.settled ||
      run.cancelled ||
      this.pendingSteer
    )
      throw acp.RequestError.invalidRequest(
        undefined,
        "No available Pi turn for steer",
      );
    const { message, images } = this.promptContent(request.prompt);
    const pending = {
      id: request.steerId,
      run,
      applied: deferred<void>(),
    };
    this.pendingSteer = pending;
    try {
      // The extension preserves identity in Pi metadata and atomically injects or refuses.
      await this.rpc.request("prompt", {
        message:
          `/${this.steerCommand} ` +
          JSON.stringify({
            steerId: request.steerId,
            content: [{ type: "text", text: message }, ...images],
          }),
      });
      await pending.applied.promise;
      return { outcome: "injected" } as T;
    } finally {
      if (this.pendingSteer === pending) this.pendingSteer = undefined;
    }
  };
}

export function initializeResponse(): acp.InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: "pi-rpc", version: PI_RPC_VERSION },
    agentCapabilities: {
      _meta: {
        lody: {
          usage: { version: 1 },
          compaction: { version: 1 },
          steering: {
            version: 1,
            transport: "request",
            upstreamTurn: "same",
            configPolicy: "active",
          },
        },
      },
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { resume: {} },
    },
    authMethods: [],
  };
}
