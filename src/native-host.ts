import type {
  AgentSession,
  AgentSessionRuntime,
  BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { OperationCancelled, Operations } from "./operations.js";

/** SDK host metadata projection. Pi still builds and owns the actual prompt. */
export function nativePromptOptions(
  session: AgentSession,
): BuildSystemPromptOptions {
  const loader = session.resourceLoader;
  const toolSnippets: Record<string, string> = {};
  const promptGuidelines: string[] = [];
  const selectedTools = session.getActiveToolNames();
  for (const name of selectedTools) {
    const tool = session.getToolDefinition(name);
    const snippet = tool?.promptSnippet?.replace(/\s+/g, " ").trim();
    if (snippet) toolSnippets[name] = snippet;
    promptGuidelines.push(
      ...new Set(
        (tool?.promptGuidelines ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
  }
  return {
    cwd: session.sessionManager.getCwd(),
    skills: loader.getSkills().skills,
    contextFiles: loader.getAgentsFiles().agentsFiles,
    customPrompt: loader.getSystemPrompt(),
    appendSystemPrompt:
      loader.getAppendSystemPrompt().join("\n\n") || undefined,
    selectedTools,
    toolSnippets,
    promptGuidelines,
  };
}

/** Public SDK facade: delegate execution, retain the lifetime of accepted calls. */
export function ownRuntime(native: AgentSessionRuntime): AgentSessionRuntime {
  const operations = new Operations((event) => {
    native.session.extensionRunner
      .createContext()
      .ui.notify(
        "lody-rpc:" + JSON.stringify({ type: `lody_background_${event}` }),
        "info",
      );
  });
  let current: AgentSession | undefined;
  let facade: AgentSession;
  const session = (): AgentSession => {
    if (current === native.session) return facade;
    current = native.session;
    const target = current;
    let bindings: Parameters<AgentSession["bindExtensions"]>[0] = {};
    const report = (event: string, error: unknown) =>
      target.extensionRunner.emitError({
        extensionPath: "<runtime>",
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    const fire = (event: string, action: () => Promise<unknown>) => {
      void operations.call(action).catch((error) => report(event, error));
    };
    const abort = () =>
      operations.cancel(async () => {
        target.clearQueue();
        await target.abort();
      });
    const bind = () => {
      const runtime = target.resourceLoader.getExtensions().runtime;
      // Retain native dynamic provider registration semantics when rebinding ctx.*.
      const providers = {
        registerProvider: runtime.registerProvider,
        registerNativeProvider: runtime.registerNativeProvider,
        unregisterProvider: runtime.unregisterProvider,
      };
      const setModel = runtime.setModel;
      target.extensionRunner.bindCore(
        {
          ...runtime,
          sendUserMessage: (content, options) =>
            fire("send_user_message", () =>
              target.sendUserMessage(content, options),
            ),
          sendMessage: (message, options) =>
            fire("send_message", () =>
              target.sendCustomMessage(message, options),
            ),
          setModel: (model) => operations.call(() => setModel(model)),
        },
        {
          getModel: () => target.model,
          getScopedModels: () => target.scopedModels,
          isIdle: () => target.isIdle,
          isProjectTrusted: () => target.settingsManager.isProjectTrusted(),
          getSignal: () => target.agent.signal,
          abort: () => {
            void abort().catch((error) => report("abort", error));
          },
          hasPendingMessages: () => target.pendingMessageCount > 0,
          shutdown: () => bindings.shutdownHandler?.(),
          getContextUsage: () => target.getContextUsage(),
          compact: (options) =>
            fire("compact", async () => {
              try {
                const result = await target.compact(
                  options?.customInstructions,
                );
                options?.onComplete?.(result);
              } catch (error) {
                options?.onError?.(
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            }),
          getSystemPrompt: () => target.systemPrompt,
          getSystemPromptOptions: () => nativePromptOptions(target),
        },
        providers,
      );
    };
    bind();
    target.subscribe((event) => {
      // compact() creates its abort controller after awaiting native idle. Stop
      // may already have been accepted during that await; cancel the new controller.
      if (event.type === "compaction_start" && operations.cancelled)
        target.abortCompaction();
    });
    const stream = target.agent.streamFunction;
    target.agent.streamFunction = (...args) => {
      if (operations.cancelled) {
        target.agent.abort();
        throw new Error("Pi operation cancelled");
      }
      return stream(...args);
    };
    const overrides: Partial<AgentSession> = {
      prompt: async (text, options) => {
        // The owned worker's response means completion, not native preflight ACK.
        // Retain Pi's JSONL/UI implementation; do not run a second executor.
        const action = () =>
          target.prompt(text, { ...options, preflightResult: undefined });
        try {
          await (options?.streamingBehavior
            ? operations.call(action)
            : operations.enter(action));
        } catch (error) {
          if (!(error instanceof OperationCancelled)) throw error;
        }
        options?.preflightResult?.(true);
      },
      compact: (instructions) =>
        operations.call(() => target.compact(instructions)),
      setModel: (...args) => operations.enter(() => target.setModel(...args)),
      abort,
      bindExtensions: (options) =>
        operations.call(async () => {
          bindings = { ...bindings, ...options };
          await target.bindExtensions(options);
        }),
      reload: (options) =>
        operations.call(() =>
          target.reload({
            beforeSessionStart: async () => {
              bind();
              await options?.beforeSessionStart?.();
            },
          }),
        ),
    };
    facade = new Proxy(target, {
      get(object, key) {
        if (key in overrides) return Reflect.get(overrides, key);
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
    return facade;
  };
  // Fresh replacement contexts have their own native send methods. Preserve lazy
  // stale-context getters while routing those methods through the same owner.
  const replaceOptions = (
    options: Parameters<AgentSessionRuntime["newSession"]>[0],
  ) =>
    options?.withSession
      ? {
          ...options,
          withSession: async (
            context: Parameters<
              NonNullable<
                NonNullable<
                  Parameters<AgentSessionRuntime["newSession"]>[0]
                >["withSession"]
              >
            >[0],
          ) => {
            const fresh = Object.defineProperties(
              {},
              Object.getOwnPropertyDescriptors(context),
            ) as typeof context;
            fresh.sendUserMessage = (...args) =>
              operations.call(() => context.sendUserMessage(...args));
            fresh.sendMessage = (...args) =>
              operations.call(() => context.sendMessage(...args));
            await options.withSession!(fresh);
          },
        }
      : options;
  return new Proxy(native, {
    get(object, key) {
      if (key === "session") return session();
      if (key === "setRebindSession")
        return (
          callback: Parameters<AgentSessionRuntime["setRebindSession"]>[0],
        ) =>
          object.setRebindSession(
            callback ? () => callback(session()) : undefined,
          );
      if (key === "newSession")
        return (options: Parameters<AgentSessionRuntime["newSession"]>[0]) =>
          operations.enter(() => object.newSession(replaceOptions(options)));
      if (key === "fork")
        return (
          id: string,
          options: Parameters<AgentSessionRuntime["fork"]>[1],
        ) =>
          operations.enter(() =>
            object.fork(id, { ...options, ...replaceOptions(options) }),
          );
      if (key === "switchSession")
        return (
          path: string,
          options: Parameters<AgentSessionRuntime["switchSession"]>[1],
        ) =>
          operations.enter(() =>
            object.switchSession(path, {
              ...options,
              ...replaceOptions(options),
            }),
          );
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
