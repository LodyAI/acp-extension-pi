import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

// Research probe for the pinned SDK, not an ACP acceptance suite. Some cases
// deliberately assert counterexamples. See sdk-lifecycle-findings.md.
const originalCwd = process.cwd();
const labRoot = await mkdtemp(join(tmpdir(), "pi-sdk-lifecycle-"));
const providerPath = fileURLToPath(
  new URL("../test/fixtures/provider.mjs", import.meta.url),
);
process.on("exit", () => {
  process.chdir(originalCwd);
  rmSync(labRoot, { recursive: true, force: true });
});
const results = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function test(name, fn) {
  const watchdog = setTimeout(() => {
    console.error("WATCHDOG", name);
    process.exit(2);
  }, 15000);
  try {
    const evidence = await fn();
    results.push({ name, ...evidence });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    clearTimeout(watchdog);
  }
}
async function fixture(extension, options = {}) {
  const cwd = await mkdtemp(join(labRoot, "case-"));
  process.chdir(cwd);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "lody-fixture",
    defaultModel: "fixture",
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 99999 },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd + "/profile",
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => options.systemPrompt,
    additionalExtensionPaths: [providerPath],
    extensionFactories: [extension],
    extensionsOverride: (base) => {
      if (options.provider)
        for (const registration of base.runtime.pendingProviderRegistrations) {
          if (registration.name === "lody-fixture")
            registration.config = options.provider(registration.config);
        }
      return base;
    },
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd,
    agentDir: cwd + "/profile",
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const session = created.session;
  const pending = new Set(),
    errors = [],
    events = [];
  let closed = false;
  const own = (fn) => {
    if (closed) return Promise.resolve();
    const p = fn();
    pending.add(p);
    void p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    );
    return p;
  };
  const notice = (event, e) =>
    session.extensionRunner.emitError({
      extensionPath: "<runtime>",
      event,
      error: String(e.message ?? e),
    });
  function bind(full = options.full) {
    const runtime = loader.getExtensions().runtime;
    if (!options.ablateMessages) {
      runtime.sendUserMessage = (content, opts) => {
        void own(() => session.sendUserMessage(content, opts)).catch((e) =>
          notice("send_user_message", e),
        );
      };
      runtime.sendMessage = (message, opts) => {
        void own(() => session.sendCustomMessage(message, opts)).catch((e) =>
          notice("send_message", e),
        );
      };
    }
    if (full)
      session.extensionRunner.bindCore(
        { ...runtime },
        {
          getModel: () => session.model,
          getScopedModels: () => session.scopedModels,
          isIdle: () => session.isIdle,
          isProjectTrusted: () => settingsManager.isProjectTrusted(),
          getSignal: () => session.agent.signal,
          abort: () => {
            void session.abort();
          },
          hasPendingMessages: () => session.pendingMessageCount > 0,
          shutdown: () => {},
          getContextUsage: () => session.getContextUsage(),
          compact: (opts) => {
            void own(async () => {
              try {
                const result = await session.compact(opts?.customInstructions);
                opts?.onComplete?.(result);
              } catch (e) {
                opts?.onError?.(e);
              }
            });
          },
          getSystemPrompt: () => session.systemPrompt,
        },
      );
  }
  bind();
  session.subscribe((e) => events.push(e));
  await session.setModel(
    session.modelRuntime.getModel("lody-fixture", "fixture"),
  );
  await session.bindExtensions({
    onError: (e) => errors.push(e),
    ...options.bindings,
  });
  return {
    session,
    loader,
    pending,
    errors,
    events,
    bind,
    own,
    close: () => {
      closed = true;
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    dispose: () => session.dispose(),
  };
}

for (const ablateMessages of [true, false])
  await test(`settled-followup-${ablateMessages ? "ablation" : "owned"}`, async () => {
    const entered = deferred(),
      release = deferred();
    let again = false;
    const f = await fixture(
      (pi) => {
        pi.on("before_agent_start", async (e) => {
          if (e.prompt === "root") again = true;
          if (e.prompt === "child") {
            entered.resolve();
            await release.promise;
          }
        });
        pi.on("agent_settled", () => {
          if (again) {
            again = false;
            pi.sendUserMessage("child");
          }
        });
      },
      { ablateMessages },
    );
    await f.session.prompt("root");
    await entered.promise;
    assert.equal(f.pending.size, ablateMessages ? 0 : 1);
    assert.equal(f.session.isIdle, true);
    const settled = deferred();
    const off = f.session.subscribe((e) => {
      if (e.type === "agent_settled") settled.resolve();
    });
    release.resolve();
    await settled.promise;
    await f.drain();
    off();
    await f.session.prompt("recovery");
    f.dispose();
    return {
      parentReturnedWhileChildGated: true,
      pending: ablateMessages ? 0 : 1,
      recovery: true,
    };
  });

await test("nested-followups-and-command-waitForIdle", async () => {
  const entered = deferred(),
    release = deferred();
  let stage = 0;
  const f = await fixture((pi) => {
    pi.on("agent_settled", () => {
      if (stage++ < 2)
        pi.sendUserMessage("/child", { expandPromptTemplates: true });
    });
    pi.registerCommand("child", {
      handler: async (_a, ctx) => {
        await ctx.waitForIdle();
        entered.resolve();
        await release.promise;
        pi.sendUserMessage("nested");
      },
    });
  });
  await f.session.bindExtensions({
    commandContextActions: { waitForIdle: () => f.session.waitForIdle() },
  });
  await f.session.prompt("root");
  await entered.promise;
  assert.ok(f.pending.size > 0);
  release.resolve();
  await f.drain();
  assert.equal(stage, 3);
  f.dispose();
  return { runs: stage, selfDeadlock: false };
});

await test("custom-triggerTurn", async () => {
  const entered = deferred(),
    release = deferred();
  let first = true;
  const f = await fixture((pi) => {
    pi.on("agent_settled", () => {
      if (first) {
        first = false;
        pi.sendMessage(
          { customType: "synthetic", content: "child", display: true },
          { triggerTurn: true },
        );
      }
    });
    pi.on("context", async () => {
      if (!first) {
        entered.resolve();
        await release.promise;
      }
    });
  });
  await f.session.prompt("root");
  await entered.promise;
  assert.equal(f.pending.size, 1);
  release.resolve();
  await f.drain();
  f.dispose();
  return { owned: true };
});

for (const full of [false, true])
  await test(`extension-compaction-${full ? "bound" : "ablation"}`, async () => {
    const entered = deferred(),
      release = deferred();
    let compactDone = deferred();
    const f = await fixture(
      (pi) => {
        pi.on("session_before_compact", async (e) => {
          entered.resolve();
          await release.promise;
          return {
            compaction: {
              summary: "Synthetic summary",
              firstKeptEntryId: e.preparation.firstKeptEntryId,
              tokensBefore: e.preparation.tokensBefore,
            },
          };
        });
        pi.registerCommand("compact-lab", {
          handler: (_a, ctx) =>
            ctx.compact({
              onComplete: () => compactDone.resolve(),
              onError: (e) => compactDone.resolve(e),
            }),
        });
      },
      { full },
    );
    await f.session.prompt("seed");
    await f.session.prompt("/compact-lab");
    await entered.promise;
    assert.equal(f.pending.size, full ? 1 : 0);
    release.resolve();
    assert.equal(await compactDone.promise, undefined);
    await f.drain();
    f.dispose();
    return { commandReturnedWhileCompactionGated: true, pending: full ? 1 : 0 };
  });

for (const stage of ["input", "before_agent_start"])
  await test(`cancel-${stage}`, async () => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture((pi) =>
      pi.on(stage, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    const work = f.own(() => f.session.prompt("cancelled request"));
    await entered.promise;
    f.session.clearQueue();
    await f.session.abort();
    assert.equal(f.pending.size, 1);
    assert.equal(f.session.isIdle, true);
    const before = f.events.filter((e) => e.type === "agent_start").length;
    release.resolve();
    await work;
    const after = f.events.filter((e) => e.type === "agent_start").length;
    assert.equal(after - before, 1);
    f.dispose();
    return {
      abortReturnedWhileGated: true,
      agentRunsAfterAbort: after - before,
      verdict: "BLOCKED",
    };
  });

for (const stage of ["input", "before_agent_start"])
  await test(`cancel-stream-boundary-${stage}`, async () => {
    const entered = deferred(),
      release = deferred();
    let cancelled = false,
      providerCalls = 0;
    const f = await fixture((pi) =>
      pi.on(stage, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    // Agent declares streamFunction as a public configurable callback. Preserve
    // Pi's installed provider/auth implementation for all accepted calls.
    const native = f.session.agent.streamFunction;
    f.session.agent.streamFunction = (...args) => {
      if (cancelled) {
        f.session.agent.abort();
        throw Error("Synthetic accepted cancellation");
      }
      providerCalls++;
      return native(...args);
    };
    const work = f.own(() => f.session.prompt("cancelled"));
    await entered.promise;
    cancelled = true;
    f.close();
    f.session.clearQueue();
    await f.session.abort();
    assert.equal(f.pending.size, 1);
    release.resolve();
    await work;
    assert.equal(providerCalls, 0);
    assert.equal(f.session.state.messages.at(-1).stopReason, "aborted");
    cancelled = false;
    await f.session.prompt("recovery");
    assert.equal(providerCalls, 1);
    f.dispose();
    return {
      nativeWorkDrainedAfterGate: true,
      providerCallsAfterCancel: 0,
      recovery: true,
      limitation: "cannot interrupt plugin preflight",
    };
  });

await test("cancel-model-and-callback-new-work", async () => {
  const entered = deferred();
  let triggered = false;
  const f = await fixture((pi) => {
    pi.on("tool_execution_start", () => entered.resolve());
    pi.on("agent_settled", () => {
      if (!triggered) {
        triggered = true;
        pi.sendUserMessage("after cancel");
      }
    });
  });
  const work = f.own(() => f.session.prompt("gate fixture"));
  await entered.promise;
  f.close();
  f.session.clearQueue();
  await f.session.abort();
  await work;
  await f.drain();
  assert.equal(f.events.filter((e) => e.type === "agent_start").length, 1);
  f.dispose();
  return { closedRequestRejectsNewWork: true, runs: 1 };
});

await test("command-error-and-callback-diagnostic", async () => {
  const f = await fixture((pi) => {
    pi.registerCommand("fail-lab", {
      handler: async () => {
        throw Error("synthetic command failure");
      },
    });
    pi.on("agent_settled", () => {
      throw Error("synthetic callback notice");
    });
  });
  await f.session.prompt("/fail-lab");
  assert.ok(f.errors.some((e) => e.error.includes("command failure")));
  await f.session.prompt("success");
  assert.ok(f.errors.some((e) => e.error.includes("callback notice")));
  assert.equal(f.session.state.messages.at(-1).stopReason, "stop");
  f.dispose();
  return {
    commandFailureNeedsErrorEvent: true,
    callbackDidNotChangeModelOutcome: true,
  };
});

for (const tool of [false, true])
  await test(`question-${tool ? "tool" : "command"}-cancel-and-late-answer`, async () => {
    const entered = deferred(),
      answer = deferred();
    let value,
      active = true;
    const respond = (value) => {
      if (!active) return false;
      active = false;
      answer.resolve(value);
      return true;
    };
    const f = await fixture(
      (pi) => {
        pi.registerCommand("ask-lab", {
          handler: async (_a, ctx) => {
            value = await ctx.ui.input("Synthetic question");
          },
        });
        pi.registerTool({
          name: "question",
          label: "Synthetic question",
          description: "Lab UI question",
          parameters: { type: "object", properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => {
            value = await ctx.ui.input("Synthetic question");
            return { content: [{ type: "text", text: value ?? "cancelled" }] };
          },
        });
      },
      {
        bindings: {
          uiContext: {
            input: () => {
              entered.resolve();
              return answer.promise;
            },
          },
        },
      },
    );
    const work = f.own(() =>
      f.session.prompt(tool ? "question fixture" : "/ask-lab"),
    );
    await entered.promise;
    assert.equal(f.pending.size, 1);
    f.close();
    respond(undefined);
    await f.session.abort();
    await work;
    assert.equal(respond("late answer"), false);
    assert.equal(value, undefined);
    await f.session.prompt("recovery");
    f.dispose();
    return { ownedUntilAnswered: true, cancelledUIIgnoresLateAnswer: true };
  });

await test("reload-startup-actions-and-stale-api", async () => {
  let oldPi;
  let starts = 0;
  const entered = deferred(),
    release = deferred();
  const f = await fixture((pi) => {
    oldPi ??= pi;
    pi.on("session_start", () => {
      starts++;
      if (starts > 1) pi.sendUserMessage("reload child");
    });
    pi.on("before_agent_start", async (e) => {
      if (e.prompt === "reload child") {
        entered.resolve();
        await release.promise;
      }
    });
  });
  await f.session.reload({ beforeSessionStart: () => f.bind() });
  await entered.promise;
  assert.equal(f.pending.size, 1);
  assert.throws(() => oldPi.sendUserMessage("stale"), /stale/);
  release.resolve();
  await f.drain();
  f.dispose();
  return { reboundBeforeStartup: true, staleApiRejected: true };
});

await test("initial-session-start-work", async () => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture((pi) => {
    pi.on("session_start", () => pi.sendUserMessage("startup"));
    pi.on("before_agent_start", async () => {
      entered.resolve();
      await release.promise;
    });
  });
  await entered.promise;
  assert.equal(f.pending.size, 1);
  release.resolve();
  await f.drain();
  f.dispose();
  return { setupMustDrainStartupWork: true };
});

for (const cancel of [false, true])
  await test(`auto-compaction-${cancel ? "cancel" : "complete"}`, async () => {
    const entered = deferred(),
      release = deferred();
    let arm = false;
    const f = await fixture((pi) => {
      pi.on("agent_start", () => {
        if (arm) f.session.setAutoCompactionEnabled(true);
      });
      pi.on("session_before_compact", async (e) => {
        entered.resolve();
        await Promise.race([
          release.promise,
          new Promise((r) => {
            if (e.signal.aborted) r();
            else e.signal.addEventListener("abort", r, { once: true });
          }),
        ]);
        if (e.signal.aborted) return { cancel: true };
        return {
          compaction: {
            summary: "Synthetic auto summary",
            firstKeptEntryId: e.preparation.firstKeptEntryId,
            tokensBefore: e.preparation.tokensBefore,
          },
        };
      });
    });
    await f.session.prompt("seed");
    // Trigger the real threshold path without a commercial provider.
    arm = true;
    const work = f.own(() => f.session.prompt("auto"));
    await entered.promise;
    assert.equal(f.pending.size, 1);
    if (cancel) {
      f.close();
      f.session.clearQueue();
      await f.session.abort();
    } else release.resolve();
    await work;
    await f.drain();
    assert.equal(f.session.isCompacting, false);
    f.dispose();
    return { nativePromptOwnsAutoCompaction: true, cancel };
  });

await test("reload-failure-invalidates-old-api", async () => {
  let api;
  const f = await fixture((pi) => {
    api = pi;
  });
  // ResourceLoader.reload is an injected service method, not an AgentSession patch.
  f.loader.reload = async () => {
    throw Error("synthetic loader failure");
  };
  await assert.rejects(
    f.session.reload({ beforeSessionStart: () => f.bind() }),
    /synthetic loader failure/,
  );
  assert.throws(() => api.sendUserMessage("stale"), /stale/);
  f.dispose();
  return { oldApiInvalid: true, hostMustInvalidateACPBinding: true };
});

for (const action of ["new", "fork", "switch", "failed-new"])
  await test(`runtime-replacement-${action}`, async () => {
    const cwd = await mkdtemp(join(labRoot, "replacement-"));
    process.chdir(cwd);
    const entered = deferred(),
      release = deferred();
    let starts = 0,
      oldApi,
      fail = false,
      rebinds = 0;
    const pending = new Set();
    const factory = async (args) => {
      if (fail) throw Error("synthetic create failure");
      const settingsManager = SettingsManager.inMemory({
        defaultProvider: "lody-fixture",
        defaultModel: "fixture",
        compaction: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd + "/profile",
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [providerPath],
        extensionFactories: [
          (pi) => {
            oldApi ??= pi;
            pi.on("session_start", () => {
              if (++starts > 1) pi.sendUserMessage("replacement child");
            });
            pi.on("before_agent_start", async (e) => {
              if (e.prompt === "replacement child") {
                entered.resolve();
                await release.promise;
              }
            });
          },
        ],
      });
      await loader.reload();
      const result = await createAgentSession({
        ...args,
        settingsManager,
        resourceLoader: loader,
      });
      const s = result.session;
      await s.setModel(s.modelRuntime.getModel("lody-fixture", "fixture"));
      result.extensionsResult.runtime.sendUserMessage = (text, opts) => {
        const p = s.sendUserMessage(text, opts);
        pending.add(p);
        void p.finally(() => pending.delete(p));
      };
      return {
        ...result,
        services: { cwd, agentDir: cwd + "/profile" },
        diagnostics: [],
      };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: cwd + "/profile",
      sessionManager: SessionManager.create(cwd, cwd + "/sessions"),
    });
    const bind = async (s) => {
      rebinds++;
      await s.bindExtensions({ onError: () => {} });
    };
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    await runtime.session.setModel(
      runtime.session.modelRuntime.getModel("lody-fixture", "fixture"),
    );
    await runtime.session.prompt("seed");
    const old = runtime.session,
      oldFile = old.sessionFile;
    if (action === "failed-new") {
      fail = true;
      await assert.rejects(runtime.newSession(), /synthetic create failure/);
      assert.throws(() => oldApi.sendUserMessage("stale"), /stale/);
      await runtime.dispose();
      return {
        failurePropagates: true,
        oldApiInvalid: true,
        hostMustClearBinding: true,
      };
    }
    if (action === "new") await runtime.newSession();
    if (action === "fork")
      await runtime.fork(old.sessionManager.getLeafId(), { position: "at" });
    if (action === "switch") await runtime.switchSession(oldFile);
    await entered.promise;
    assert.equal(pending.size, 1);
    assert.notEqual(runtime.session, old);
    assert.throws(() => oldApi.sendUserMessage("stale"), /stale/);
    release.resolve();
    while (pending.size) await Promise.all([...pending]);
    assert.equal(rebinds, 2);
    await runtime.dispose();
    return {
      reboundBeforeStartup: true,
      oldApiInvalid: true,
      sameFile: runtime.session.sessionFile === oldFile,
    };
  });

for (const bind of [false, true])
  await test(`replacement-context-${bind ? "wrapped" : "ablation"}`, async () => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture((pi) =>
      pi.on("before_agent_start", async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    const native = f.session.createReplacedSessionContext();
    const ctx = bind
      ? Object.defineProperties({}, Object.getOwnPropertyDescriptors(native))
      : native;
    if (bind) {
      ctx.sendUserMessage = (...args) =>
        f.own(() => native.sendUserMessage(...args));
      ctx.sendMessage = (...args) => f.own(() => native.sendMessage(...args));
    }
    const work = ctx.sendUserMessage("fresh-context");
    await entered.promise;
    assert.equal(f.pending.size, bind ? 1 : 0);
    release.resolve();
    await work;
    f.dispose();
    return { pending: bind ? 1 : 0 };
  });

await test("provider-failure-and-recovery", async () => {
  let fail = true;
  const f = await fixture(() => {}, {
    provider: (config) => ({
      ...config,
      streamSimple(...args) {
        if (fail) throw Error("synthetic provider failure");
        return config.streamSimple(...args);
      },
    }),
  });
  await f.own(() => f.session.prompt("fail"));
  assert.equal(f.session.state.messages.at(-1).stopReason, "error");
  fail = false;
  await f.own(() => f.session.prompt("recovery"));
  assert.equal(f.session.state.messages.at(-1).stopReason, "stop");
  f.dispose();
  return { failureIsTerminalMessageNotPromiseRejection: true, recovery: true };
});

for (const close of [false, true])
  await test(`manual-compact-cancel-${close ? "closed" : "ablation"}`, async () => {
    const entered = deferred();
    const f = await fixture(
      (pi) => {
        pi.registerCommand("compact-lab", {
          handler: (_a, ctx) =>
            ctx.compact({
              onError: () => pi.sendUserMessage("after compact cancel"),
            }),
        });
        pi.on("session_before_compact", async (e) => {
          entered.resolve();
          await new Promise((r) => {
            if (e.signal.aborted) r();
            else e.signal.addEventListener("abort", r, { once: true });
          });
          return { cancel: true };
        });
      },
      { full: true },
    );
    await f.session.prompt("seed");
    await f.session.prompt("/compact-lab");
    await entered.promise;
    if (close) f.close();
    f.session.clearQueue();
    await f.session.abort();
    await f.drain();
    const runs = f.events.filter((e) => e.type === "agent_start").length;
    assert.equal(runs, close ? 1 : 2);
    f.dispose();
    return { runsAfterSeed: runs - 1 };
  });

await test("nextTurn-does-not-start-a-model", async () => {
  const f = await fixture((pi) =>
    pi.registerCommand("context-lab", {
      handler: () =>
        pi.sendMessage(
          {
            customType: "lab",
            content: "Synthetic hidden context",
            display: false,
          },
          { deliverAs: "nextTurn" },
        ),
    }),
  );
  await f.own(() => f.session.prompt("/context-lab"));
  await f.drain();
  assert.equal(f.events.filter((e) => e.type === "agent_start").length, 0);
  await f.session.prompt("consume");
  assert.ok(f.session.state.messages.some((m) => m.role === "custom"));
  f.dispose();
  return { queuedWithoutSpuriousRun: true };
});

await test("full-binding-loses-native-prompt-options", async () => {
  const f = await fixture(() => {}, {
    systemPrompt: "SYNTHETIC_CUSTOM_SYSTEM_PROMPT",
  });
  const before = f.session.extensionRunner
    .createCommandContext()
    .getSystemPromptOptions();
  const prompt = f.session.systemPrompt;
  assert.equal(before.customPrompt, "SYNTHETIC_CUSTOM_SYSTEM_PROMPT");
  f.bind(true);
  const after = f.session.extensionRunner
    .createCommandContext()
    .getSystemPromptOptions();
  assert.equal(after.customPrompt, undefined);
  assert.equal(f.session.systemPrompt, prompt);
  f.dispose();
  return {
    modelPromptPreserved: true,
    commandPromptOptionsLost: true,
    verdict: "INCOMPLETE_CONTEXT_BINDING",
  };
});

await test("dispose-does-not-cancel-preflight", async () => {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const f = await fixture(
    (pi) =>
      pi.on("before_agent_start", async () => {
        entered.resolve();
        await release.promise;
      }),
    {
      provider: (config) => ({
        ...config,
        streamSimple(...args) {
          calls++;
          return config.streamSimple(...args);
        },
      }),
    },
  );
  const work = f.session.prompt("pending");
  await entered.promise;
  f.dispose();
  release.resolve();
  await work;
  assert.equal(calls, 1);
  return {
    providerCallsAfterDispose: calls,
    verdict: "DISCONNECT_REQUIRES_OWNED_PROCESS_SHUTDOWN",
  };
});

await test("detached-work-is-a-later-operation", async () => {
  const trigger = deferred(),
    entered = deferred(),
    release = deferred();
  let first = true;
  const f = await fixture((pi) => {
    pi.on("agent_settled", () => {
      if (!first) return;
      first = false;
      void trigger.promise.then(() => pi.sendUserMessage("background"));
    });
    pi.on("before_agent_start", async (event) => {
      if (event.prompt !== "background") return;
      entered.resolve();
      await release.promise;
    });
  });
  await f.own(() => f.session.prompt("root"));
  await f.drain();
  assert.equal(f.pending.size, 0);
  trigger.resolve();
  await entered.promise;
  assert.equal(f.pending.size, 1);
  release.resolve();
  await f.drain();
  f.dispose();
  return {
    originalFinishedBeforeBackgroundStarted: true,
    needsSeparateAdmission: true,
  };
});

console.log("MATRIX_COMPLETE", results.length);
