import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ownRuntime } from "../dist/native-host.js";

const root = await mkdtemp(join(tmpdir(), "pi-sdk-host-"));
const originalCwd = process.cwd();
const provider = fileURLToPath(
  new URL("../test/fixtures/provider.mjs", import.meta.url),
);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
const watchdog = setTimeout(() => {
  throw Error("SDK host watchdog");
}, 15000);
async function fixture(extension, uiContext) {
  const cwd = await mkdtemp(join(root, "case-"));
  process.chdir(cwd);
  const errors = [],
    originals = [];
  let fail = false;
  const native = await createAgentSessionRuntime(
    async (args) => {
      if (fail) throw Error("Synthetic factory failure");
      const settingsManager = SettingsManager.inMemory({
        defaultProvider: "lody-fixture",
        defaultModel: "fixture",
        compaction: {
          enabled: false,
          keepRecentTokens: 1,
          reserveTokens: 99999,
        },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: [provider],
        extensionFactories: [extension],
        systemPrompt: "SYNTHETIC_CUSTOM_PROMPT",
      });
      await loader.reload();
      const result = await createAgentSession({
        ...args,
        settingsManager,
        resourceLoader: loader,
      });
      await result.session.setModel(
        result.session.modelRuntime.getModel("lody-fixture", "fixture"),
      );
      originals.push(
        result.session.extensionRunner
          .createCommandContext()
          .getSystemPromptOptions(),
      );
      return { ...result, services: { cwd, agentDir: cwd }, diagnostics: [] };
    },
    {
      cwd,
      agentDir: cwd,
      sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    },
  );
  const host = ownRuntime(native);
  const bind = (session) =>
    session.bindExtensions({
      onError: (error) => errors.push(error),
      uiContext,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) => host.newSession(options),
        fork: (id, options) => host.fork(id, options),
        switchSession: (path, options) => host.switchSession(path, options),
        reload: () => session.reload(),
        navigateTree: async () => ({ cancelled: true }),
      },
    });
  host.setRebindSession(bind);
  await bind(host.session);
  return {
    host,
    native,
    errors,
    originals,
    fail: () => {
      fail = true;
    },
    close: () => host.dispose(),
  };
}
try {
  // Native metadata remains authoritative across dynamic tools and reload. No
  // host snapshot may silently preserve stale tool/prompt configuration.
  let eventOptions;
  const metadata = await fixture((pi) => {
    pi.on("before_agent_start", (event) => {
      eventOptions = event.systemPromptOptions;
    });
    pi.registerCommand("change-tools", {
      handler: () => {
        pi.registerTool({
          name: "metadata_tool",
          label: "Metadata",
          description: "Synthetic",
          promptSnippet: "  multi\n line  ",
          promptGuidelines: [" rule ", "rule", ""],
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [] }),
        });
        pi.setActiveTools(["metadata_tool"]);
      },
    });
  });
  assert.deepEqual(
    metadata.host.session.extensionRunner
      .createCommandContext()
      .getSystemPromptOptions(),
    metadata.originals[0],
  );
  await metadata.host.session.prompt("/change-tools");
  await metadata.host.session.prompt("metadata");
  assert.deepEqual(
    metadata.host.session.extensionRunner
      .createCommandContext()
      .getSystemPromptOptions(),
    eventOptions,
  );
  assert.deepEqual(eventOptions.selectedTools, ["metadata_tool"]);
  await metadata.host.session.reload();
  await metadata.host.session.prompt("after reload");
  assert.deepEqual(
    metadata.host.session.extensionRunner
      .createCommandContext()
      .getSystemPromptOptions(),
    eventOptions,
  );
  await metadata.close();

  // A detached action after completion is allowed. It holds admission for a new
  // user request; it is not silently assigned to the already completed request.
  const trigger = deferred(),
    entered = deferred(),
    release = deferred();
  const starts = [];
  const background = await fixture((pi) => {
    pi.registerCommand("arm", {
      handler: () => {
        void trigger.promise.then(() => pi.sendUserMessage("background"));
      },
    });
    pi.on("before_agent_start", async (event) => {
      starts.push(event.prompt);
      if (event.prompt === "background") {
        entered.resolve();
        await release.promise;
      }
    });
  });
  await background.host.session.prompt("/arm");
  trigger.resolve();
  await entered.promise;
  const next = background.host.session.prompt("next request");
  release.resolve();
  await next;
  assert.deepEqual(starts, ["background", "next request"]);
  await background.close();

  // Cancelled ancestry must not leak into a later request or restart from a
  // callback that was already scheduled by the cancelled request.
  const cancelledGate = deferred(),
    cancelRelease = deferred(),
    late = deferred(),
    lateInvoked = deferred();
  const seen = [];
  const cancellation = await fixture((pi) => {
    pi.on("before_agent_start", async (event) => {
      seen.push(event.prompt);
      if (event.prompt === "cancel me") {
        void late.promise.then(() => {
          pi.sendUserMessage("late cancelled work");
          lateInvoked.resolve();
        });
        cancelledGate.resolve();
        await cancelRelease.promise;
      }
    });
  });
  const pending = cancellation.host.session.prompt("cancel me");
  await cancelledGate.promise;
  const stopping = cancellation.host.session.abort();
  cancelRelease.resolve();
  await Promise.all([pending, stopping]);
  late.resolve();
  await lateInvoked.promise;
  await cancellation.host.session.prompt("recovered");
  assert.deepEqual(seen, ["cancel me", "recovered"]);
  assert.equal(cancellation.host.session.messages.at(-1).stopReason, "stop");
  await cancellation.close();

  // Startup and replacement callbacks, including the fresh withSession API,
  // use exactly the same native owner and retain old-context invalidation.
  for (const kind of ["new", "fork", "switch", "failure"]) {
    let oldPi,
      first = true;
    const replaced = await fixture((pi) => {
      oldPi ??= pi;
      pi.on("session_start", () => {
        if (first) first = false;
        else pi.sendUserMessage("startup continuation");
      });
    });
    await replaced.host.session.prompt("seed");
    const oldFile = replaced.host.session.sessionFile;
    const options = {
      withSession: async (ctx) => {
        void ctx.sendUserMessage("fresh continuation", {
          deliverAs: "followUp",
        });
      },
    };
    if (kind === "failure") {
      replaced.fail();
      await assert.rejects(replaced.host.newSession(), /factory failure/);
    }
    if (kind === "new") await replaced.host.newSession(options);
    if (kind === "fork")
      await replaced.host.fork(
        replaced.host.session.sessionManager.getLeafId(),
        { ...options, position: "at" },
      );
    if (kind === "switch") await replaced.host.switchSession(oldFile, options);
    assert.throws(() => oldPi.sendUserMessage("stale"), /stale/);
    if (kind !== "failure") {
      assert.equal(replaced.host.session.isIdle, true);
      assert.equal(replaced.host.session.messages.at(-1).stopReason, "stop");
      const text = JSON.stringify(replaced.host.session.messages);
      assert(text.includes("startup continuation"));
      assert(text.includes("fresh continuation"));
    }
    await replaced.close();
  }

  // Native command idle excludes its own owner, and custom triggerTurn and
  // manual compaction callbacks participate without another event finisher.
  let continuation = false;
  const commands = await fixture((pi) => {
    pi.registerCommand("next", {
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        pi.sendMessage(
          {
            customType: "synthetic",
            content: "custom continuation",
            display: true,
          },
          { triggerTurn: true },
        );
      },
    });
    pi.on("before_agent_start", (event) => {
      if (event.prompt === "start") continuation = true;
    });
    pi.on("agent_settled", () => {
      if (continuation) {
        continuation = false;
        pi.sendUserMessage("/next", { expandPromptTemplates: true });
      }
    });
  });
  await commands.host.session.prompt("start");
  assert.equal(commands.host.session.isIdle, true);
  assert.equal(commands.host.session.messages.at(-1).stopReason, "stop");
  assert(
    JSON.stringify(commands.host.session.messages).includes(
      "custom continuation",
    ),
  );
  await commands.close();

  for (const cancel of [false, true]) {
    const entered = deferred(),
      release = deferred();
    let arm = false,
      completed = false;
    const automatic = await fixture((pi) => {
      pi.on("agent_start", () => {
        if (arm) automatic.host.session.setAutoCompactionEnabled(true);
      });
      pi.on("session_before_compact", async (event) => {
        entered.resolve();
        await Promise.race([
          release.promise,
          new Promise((resolve) => {
            if (event.signal.aborted) resolve();
            else
              event.signal.addEventListener("abort", resolve, { once: true });
          }),
        ]);
        if (event.signal.aborted) return { cancel: true };
        return {
          compaction: {
            summary: "Synthetic automatic summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      });
    });
    await automatic.host.session.prompt("seed");
    arm = true;
    const work = automatic.host.session
      .prompt("automatic compaction")
      .then(() => {
        completed = true;
      });
    await entered.promise;
    assert.equal(completed, false);
    if (cancel) await automatic.host.session.abort();
    else release.resolve();
    await work;
    assert.equal(automatic.host.session.isCompacting, false);
    await automatic.close();
  }

  let compactOnEnd = false,
    compactSignal;
  const compactCancel = await fixture((pi) => {
    pi.on("before_agent_start", (event) => {
      if (event.prompt === "compact then stop") compactOnEnd = true;
    });
    pi.on("agent_end", (_event, ctx) => {
      if (!compactOnEnd) return;
      compactOnEnd = false;
      ctx.compact();
      ctx.abort();
    });
    pi.on("session_before_compact", (event) => {
      compactSignal = event.signal.aborted;
      return { cancel: true };
    });
  });
  await compactCancel.host.session.prompt("seed compaction");
  await compactCancel.host.session.prompt("compact then stop");
  assert.equal(
    compactSignal,
    true,
    "a compaction controller created after Stop must already be cancelled",
  );
  await compactCancel.host.session.prompt("recovery after compaction Stop");
  await compactCancel.close();
  console.log(
    "PASS: real SDK host metadata, reload, detached admission, cancelled ancestry, replacement/failure, fresh contexts and custom continuation.",
  );
} finally {
  clearTimeout(watchdog);
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}
