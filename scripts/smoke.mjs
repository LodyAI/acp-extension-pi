import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { LODY_EXTENSION_METHODS } from "acp-extension-core";
const adapterEntry =
  process.argv[2] ??
  fileURLToPath(new URL("../dist/index.js", import.meta.url));
const adapterDirectory = dirname(adapterEntry);
const { PiRpcConnection } = await import(
  pathToFileURL(join(adapterDirectory, "connection.js")).href
);
const root = await mkdtemp(join(tmpdir(), "acp-pi-smoke-"));
await mkdir(join(root, "profile"));
await writeFile(
  join(root, "profile", "settings.json"),
  JSON.stringify({ compaction: { keepRecentTokens: 128 } }),
);
const children = new Set();
let toolStarted;
let compactionStarted;
let answerQuestion = async () => ({ action: "cancel" });
const output = [];
const updates = [];
const usages = [];
let processPid;
let piPid;
function readWhenWritten(path) {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, () => void check());
    const check = async () => {
      try {
        const value = await readFile(path, "utf8");
        if (!value.trim()) return;
        watcher.close();
        resolve(value);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          watcher.close();
          reject(error);
        }
      }
    };
    watcher.once("error", reject);
    void check();
  });
}
async function start(id, mcpServers = []) {
  const child = spawn(
    process.execPath,
    [
      adapterEntry,
      "--provider",
      "lody-fixture",
      "--model",
      "fixture",
      "--no-extensions",
      "-e",
      fileURLToPath(new URL("../test/fixtures/provider.mjs", import.meta.url)),
      ...(process.env.PI_QUESTION_EXTENSION
        ? ["-e", process.env.PI_QUESTION_EXTENSION]
        : []),
    ],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        PI_CODING_AGENT_DIR: join(root, "profile"),
        PI_SKIP_VERSION_CHECK: "1",
      },
    },
  );
  children.add(child);
  child.stderr.pipe(process.stderr);
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async ({ update }) => {
        updates.push(update);
        if (
          update._meta?.lody?.activity?.kind === "context_compaction" &&
          update.status === "in_progress"
        )
          compactionStarted?.();
        if (
          update.sessionUpdate === "tool_call" &&
          update.title === "fixture_gate"
        )
          toolStarted?.();
        if (update.sessionUpdate === "agent_message_chunk")
          output.push(update.content.text);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      unstable_createElicitation: (request) => answerQuestion(request),
      extNotification: async (method, value) => {
        if (method.endsWith("lody/session/usage_update")) usages.push(value);
      },
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const info = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
  });
  assert.equal(info.agentCapabilities._meta.lody.steering.version, 1);
  assert.equal(info.agentCapabilities._meta.lody.usage.version, 1);
  await assert.rejects(
    client.newSession({
      cwd: root,
      mcpServers: [
        {
          name: "unsupported",
          type: "http",
          url: "https://fixture.invalid",
          headers: [],
        },
      ],
    }),
    /MCP/,
  );
  const session = id
    ? await client.resumeSession({ cwd: root, sessionId: id, mcpServers })
    : await client.newSession({ cwd: root, mcpServers });
  return {
    client,
    id: session.sessionId ?? id,
    async stop(signal = false) {
      const exited = once(child, "exit");
      if (signal) child.kill("SIGTERM");
      else child.stdin.end();
      await exited;
      children.delete(child);
    },
  };
}
try {
  const mcpServers = [
    {
      name: "fixture",
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../test/fixtures/mcp.mjs", import.meta.url)),
      ],
      env: [
        { name: "MCP_FIXTURE_TAG", value: "initial" },
        {
          name: "MCP_FIXTURE_SECRET",
          value: "synthetic-configuration-secret-8a52",
        },
      ],
    },
  ];
  const a = await start(undefined, mcpServers);
  const prompt = (text) =>
    a.client.prompt({ sessionId: a.id, prompt: [{ type: "text", text }] });
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hS8AAAAASUVORK5CYII=",
  };
  await a.client.prompt({
    sessionId: a.id,
    prompt: [
      { type: "text", text: "content fixture" },
      image,
      {
        type: "resource_link",
        name: "fixture.txt",
        uri: "file:///fixture.txt",
      },
      {
        type: "resource",
        resource: { uri: "file:///context.txt", text: "embedded context" },
      },
    ],
  });
  const observed = JSON.parse(
    await readFile(join(root, "content-observed.json"), "utf8"),
  );
  assert.deepEqual(
    observed.filter((block) => block.type === "image"),
    [image],
  );
  const observedText = observed
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  for (const text of [
    "content fixture",
    "fixture.txt",
    "file:///fixture.txt",
    "file:///context.txt",
    "embedded context",
  ])
    assert(observedText.includes(text));
  await assert.rejects(
    a.client.prompt({
      sessionId: a.id,
      prompt: [
        {
          type: "resource",
          resource: { uri: "file:///binary.bin", blob: "AA==" },
        },
      ],
    }),
    {
      data: {
        details:
          "Pi does not support embedded binary resources; attach an image or a file link",
      },
    },
  );
  await prompt("mcp fixture echo");
  assert(output.some((text) => text.includes("MCP:initial:native-value")));
  assert(output.some((text) => text.includes('\\"tag\\":\\"initial\\"')));
  assert(output.some((text) => text.includes('\\"secretReceived\\":true')));
  await prompt("mcp fixture error");
  assert(output.some((text) => text.startsWith('MCP_RESULT {"isError":true')));
  await prompt("mcp fixture image");
  assert(
    output.some(
      (text) =>
        text.includes('"type":"image"') &&
        text.includes('"mimeType":"image/png"'),
    ),
  );
  const mcpStarted = readWhenWritten(join(root, "mcp-started"));
  const mcpCancelled = readWhenWritten(join(root, "mcp-cancelled"));
  const mcpWait = prompt("mcp fixture wait");
  await mcpStarted;
  await a.client.cancel({ sessionId: a.id });
  assert.equal((await mcpWait).stopReason, "cancelled");
  await mcpCancelled;
  assert.equal((await prompt("write fixture")).stopReason, "end_turn");
  assert.equal(
    await readFile(join(root, "fixture.txt"), "utf8"),
    "native pi wrote this\n",
  );
  await prompt("handled fixture");
  await prompt("/ask-fixture");
  for (const [kind, value] of [
    ["input", "typed"],
    ["select", "chosen"],
    ["confirm", "Yes"],
    ["editor", "edited text"],
  ]) {
    answerQuestion = async () => ({
      action: "accept",
      content: { answer: value },
    });
    await prompt(`/ask-fixture ${kind}`);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "fixture-answer.json"), "utf8")),
      { kind, value: kind === "confirm" ? true : value },
    );
  }
  let questionSeen;
  const seen = new Promise((resolve) => {
    questionSeen = resolve;
  });
  let releaseAnswer;
  const late = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  answerQuestion = async () => {
    questionSeen();
    return late;
  };
  const pendingQuestion = prompt("/ask-fixture");
  await seen;
  await a.client.cancel({ sessionId: a.id });
  assert.equal((await pendingQuestion).stopReason, "cancelled");
  releaseAnswer({ action: "accept", content: { answer: "late answer" } });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "fixture-answer.json"), "utf8")),
    { kind: "input", value: null },
  );
  await prompt("continue after cancelling question");

  if (process.env.PI_QUESTION_EXTENSION) {
    for (const [answers, expected] of [
      [
        ["2. Same — Second route"],
        { answer: "Same", wasCustom: false, selectedIndex: 2 },
      ],
      [
        ["3. Type something.", "  My route  "],
        { answer: "My route", wasCustom: true },
      ],
      [
        ["3. Type something.", "", "1. Same — First route"],
        { answer: "Same", selectedIndex: 1 },
      ],
      [
        ["3. Type something.", null, "2. Same — Second route"],
        { answer: "Same", selectedIndex: 2 },
      ],
      [[null], { answer: null }],
    ]) {
      answerQuestion = async (request) => {
        assert.equal(request.mode, "form");
        const value = answers.shift();
        assert.notEqual(value, undefined);
        return value === null
          ? { action: "cancel" }
          : { action: "accept", content: { answer: value } };
      };
      const offset = updates.length;
      assert.equal((await prompt("question fixture")).stopReason, "end_turn");
      const result = updates
        .slice(offset)
        .find(
          (u) =>
            u.sessionUpdate === "tool_call_update" &&
            u.rawOutput?.details?.question,
        );
      assert(result, "actual question tool result must reach ACP");
      for (const [key, value] of Object.entries(expected))
        assert.deepEqual(result.rawOutput.details[key], value);
      assert.equal(answers.length, 0);
    }
    let seenQuestion;
    const arrived = new Promise((resolve) => {
      seenQuestion = resolve;
    });
    let answerLate;
    answerQuestion = async () => {
      seenQuestion();
      return new Promise((resolve) => {
        answerLate = resolve;
      });
    };
    const waiting = prompt("question fixture");
    await arrived;
    await a.client.cancel({ sessionId: a.id });
    assert.equal((await waiting).stopReason, "cancelled");
    answerLate({ action: "accept", content: { answer: "late answer" } });
    assert.equal(
      (await prompt("recovery after real question Stop")).stopReason,
      "end_turn",
    );
    console.log(
      "PASS: supplied question extension selection, duplicate labels, custom answer, empty/back, cancel/back, decline, Stop/late answer and recovery.",
    );
  }

  for (const outcome of [
    "success",
    "cancel",
    "after-run",
    "after-run-cancel",
  ]) {
    const cancelled = outcome.endsWith("cancel");
    await prompt("Prepare extension compaction " + "context ".repeat(300));
    const ready = readWhenWritten(join(root, `gate-compact-${outcome}-ready`));
    const started = new Promise((resolve) => {
      compactionStarted = resolve;
    });
    const pending = prompt(
      outcome.startsWith("after-run")
        ? "compact after run fixture" + (cancelled ? " cancel" : "")
        : `/compact-fixture ${outcome}`,
    );
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("Prompt completed before compaction was observed");
      }),
    ]);
    await ready;
    const queued =
      outcome === "after-run"
        ? prompt("queued after extension compaction")
        : undefined;
    if (!queued && !outcome.startsWith("after-run"))
      await assert.rejects(prompt("must not enter during compaction"));
    if (cancelled) await a.client.cancel({ sessionId: a.id });
    else await writeFile(join(root, `gate-compact-${outcome}-release`), "yes");
    assert.equal(
      (await pending).stopReason,
      cancelled ? "cancelled" : "end_turn",
    );
    if (queued) {
      assert.equal((await queued).stopReason, "end_turn");
      const entries = (await readFile(a.id, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      const compacted = entries.findLastIndex(
        (entry) => entry.type === "compaction",
      );
      const next = entries.findIndex(
        (entry) =>
          entry.message?.role === "user" &&
          JSON.stringify(entry.message.content).includes(
            "queued after extension compaction",
          ),
      );
      assert(next > compacted && compacted >= 0);
    }
    assert.equal(
      (await prompt("recovery after extension compaction")).stopReason,
      "end_turn",
    );
  }
  await prompt("/stats");
  await prompt("Prepare manual compaction " + "context ".repeat(300));
  await prompt("/compact retain the fixture verification outcomes");
  const compaction = updates
    .filter((u) => u._meta?.lody?.activity?.kind === "context_compaction")
    .slice(-2);
  assert.deepEqual(
    compaction.map((u) => u.status),
    ["in_progress", "completed"],
  );
  assert.equal(compaction[0].toolCallId, compaction[1].toolCallId);
  const entries = (await readFile(a.id, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(entries.some((e) => e.type === "compaction"));
  const inputTotal = entries.reduce(
    (sum, entry) =>
      sum + (entry.message?.usage?.input ?? entry.usage?.input ?? 0),
    0,
  );
  assert.equal(usages.at(-1).usage.inputTokens, inputTotal);
  assert.deepEqual(usages.at(-1).modelUsage, {});
  const ready = new Promise((resolve) => {
    toolStarted = resolve;
  });
  const running = prompt("gate fixture");
  await ready;
  await a.client.cancel({ sessionId: a.id });
  assert.equal((await running).stopReason, "cancelled");
  await a.stop();
  mcpServers[0].env[0].value = "resumed";
  const b = await start(a.id, mcpServers);
  assert.equal(b.id, a.id);
  await b.client.prompt({
    sessionId: b.id,
    prompt: [{ type: "text", text: "mcp fixture echo" }],
  });
  assert(output.some((text) => text.includes("MCP:resumed:native-value")));
  await assert.rejects(
    b.client.newSession({
      cwd: root,
      mcpServers: [
        ...mcpServers,
        {
          name: "broken",
          command: join(root, "missing-mcp-executable"),
          args: [],
          env: [],
        },
      ],
    }),
    {
      code: -32603,
      data: { details: "Required Lody Pi extension did not initialize" },
    },
  );
  await assert.rejects(
    b.client.prompt({
      sessionId: b.id,
      prompt: [{ type: "text", text: "must not use old tools" }],
    }),
  );
  mcpServers[0].env[0].value = "replacement";
  const switched = await b.client.newSession({ cwd: root, mcpServers });
  b.id = switched.sessionId;
  await b.client.prompt({
    sessionId: b.id,
    prompt: [{ type: "text", text: "mcp fixture echo" }],
  });
  assert(output.some((text) => text.includes("MCP:replacement:native-value")));
  assert.equal(
    (
      await b.client.prompt({
        sessionId: b.id,
        prompt: [{ type: "text", text: "continue" }],
      })
    ).stopReason,
    "end_turn",
  );
  await assert.rejects(
    b.client.newSession({
      cwd: root,
      mcpServers: [],
      _meta: {
        lody: {
          sessionConfig: { configOptionValues: { model: "missing/model" } },
        },
      },
    }),
    {
      code: -32603,
      data: { details: "Pi model is unavailable: missing/model" },
    },
  );
  await assert.rejects(
    b.client.prompt({
      sessionId: b.id,
      prompt: [{ type: "text", text: "must not enter replacement" }],
    }),
    {
      code: -32603,
      data: { details: "Pi session does not match the active session" },
    },
  );
  const replacement = await b.client.newSession({ cwd: root, mcpServers: [] });
  await b.client.prompt({
    sessionId: replacement.sessionId,
    prompt: [{ type: "text", text: "mcp fixture echo" }],
  });
  assert(
    output.some((text) => text.includes("Tool mcp_fixture_echo not found")),
  );
  assert.equal(
    (
      await b.client.prompt({
        sessionId: replacement.sessionId,
        prompt: [{ type: "text", text: "continue after failed setup" }],
      })
    ).stopReason,
    "end_turn",
  );
  const fifo = join(root, "process.fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const processReady = readWhenWritten(join(root, "process.pid"));
  for (const nativePath of new Set([a.id, b.id, replacement.sessionId]))
    assert(
      !(await readFile(nativePath, "utf8")).includes(
        "synthetic-configuration-secret-8a52",
      ),
    );
  const runtimePaths = new Set(
    (await readFile(join(root, "mcp-runtime-paths"), "utf8"))
      .trim()
      .split("\n"),
  );
  if (process.platform !== "win32")
    assert.equal((await stat([...runtimePaths].at(-1))).mode & 0o777, 0o600);
  const disconnected = b.client.prompt({
    sessionId: replacement.sessionId,
    prompt: [{ type: "text", text: "process fixture" }],
  });
  const rejectedOnDisconnect = assert.rejects(disconnected);
  processPid = Number((await processReady).trim());
  piPid = Number((await readFile(join(root, "pi.pid"), "utf8")).trim());
  assert(Number.isSafeInteger(processPid) && processPid > 1);
  assert(Number.isSafeInteger(piPid) && piPid > 1);
  await b.stop(true);
  await rejectedOnDisconnect;
  assert.equal(
    await readFile(join(root, "shutdown-observed"), "utf8"),
    "yes\n",
  );
  assert.throws(() => process.kill(processPid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(piPid, 0), { code: "ESRCH" });
  for (const pid of (await readFile(join(root, "mcp-pids"), "utf8"))
    .trim()
    .split("\n"))
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
  for (const configPath of new Set(
    (await readFile(join(root, "mcp-runtime-paths"), "utf8"))
      .trim()
      .split("\n"),
  ))
    await assert.rejects(stat(configPath), { code: "ENOENT" });
  const c = await start(undefined, mcpServers);
  const nativePrompt = (text) =>
    c.client.prompt({ sessionId: c.id, prompt: [{ type: "text", text }] });
  for (const kind of [
    "new",
    "fork",
    "switch",
    "tree",
    "reload",
    "failed-reload",
  ]) {
    await nativePrompt("baseline");
    if (kind === "reload" || kind === "tree") {
      assert.equal(
        (await nativePrompt(`/native-${kind}-fixture`)).stopReason,
        "end_turn",
      );
      assert.equal(
        (await nativePrompt("same file after reload")).stopReason,
        "end_turn",
      );
    } else {
      await assert.rejects(nativePrompt(`/native-${kind}-fixture`));
      await assert.rejects(nativePrompt("must not enter changed runtime"));
      c.id = (await c.client.newSession({ cwd: root, mcpServers })).sessionId;
    }
  }
  const collisionOffset = updates.length;
  await nativePrompt("dynamic MCP collision fixture");
  const collisionUpdates = updates.slice(collisionOffset);
  assert(!JSON.stringify(collisionUpdates).includes("WRONG_MCP_OWNER"));
  assert(
    collisionUpdates.some(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
    ),
  );
  await assert.rejects(nativePrompt("must refuse shadowed MCP registry"));
  await c.stop();

  // Observe Pi's command ACK before releasing the tool: ACP steer resolves only
  // when Pi consumes the queued message, so waiting for it here would deadlock.
  const configPath = join(root, "steer-servers.json");
  await writeFile(configPath, "[]");
  const native = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "./bundle/cli.js",
          import.meta.resolve("@earendil-works/pi-coding-agent"),
        ),
      ),
      "--mode",
      "rpc",
      "--provider",
      "lody-fixture",
      "--model",
      "fixture",
      "--no-extensions",
      "-e",
      fileURLToPath(new URL("../test/fixtures/provider.mjs", import.meta.url)),
      "-e",
      join(adapterDirectory, "extension.js"),
    ],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        PI_CODING_AGENT_DIR: join(root, "profile"),
        PI_SKIP_VERSION_CHECK: "1",
        LODY_PI_MCP_CONFIG: configPath,
      },
    },
  );
  children.add(native);
  native.stderr.pipe(process.stderr);
  let steerRequestId;
  let acknowledge;
  const acknowledged = new Promise((resolve) => {
    acknowledge = resolve;
  });
  let wire = "";
  let gateEntered;
  const entered = new Promise((resolve) => {
    gateEntered = resolve;
  });
  const direct = new PiRpcConnection(
    {
      writable: new WritableStream({
        write(bytes) {
          const value = JSON.parse(new TextDecoder().decode(bytes));
          if (
            value.type === "prompt" &&
            value.message.startsWith("/lody-steer-")
          )
            steerRequestId = value.id;
          native.stdin.write(bytes);
        },
      }),
      readable: Readable.toWeb(native.stdout).pipeThrough(
        new TransformStream({
          transform(bytes, controller) {
            wire += new TextDecoder().decode(bytes);
            let end;
            while ((end = wire.indexOf("\n")) >= 0) {
              const value = JSON.parse(wire.slice(0, end));
              wire = wire.slice(end + 1);
              if (value.type === "response" && value.id === steerRequestId)
                acknowledge();
            }
            controller.enqueue(bytes);
          },
        }),
      ),
    },
    {
      configureMcp: async (servers) =>
        writeFile(configPath, JSON.stringify(servers)),
      update: async ({ update }) => {
        if (
          update.sessionUpdate === "tool_call" &&
          update.title === "fixture_gate"
        )
          gateEntered();
      },
      extension: async () => {},
      usage: () => {},
      question: async () => ({ action: "cancel" }),
    },
  );
  await direct.initialize({ protocolVersion: 1 });
  const directSession = await direct.newSession({ cwd: root, mcpServers: [] });
  const runningSteer = direct.prompt({
    sessionId: directSession.sessionId,
    prompt: [{ type: "text", text: "gate fixture" }],
  });
  await entered;
  const steering = direct.request(LODY_EXTENSION_METHODS.sessionSteer, {
    sessionId: directSession.sessionId,
    steerId: "native-owner-proof",
    prompt: [{ type: "text", text: "steered fixture" }],
  });
  await acknowledged;
  await writeFile(join(root, "release-gate"), "release");
  assert.deepEqual(await steering, { outcome: "injected" });
  assert.equal((await runningSteer).stopReason, "end_turn");
  const nativeExited = once(native, "exit");
  native.stdin.end();
  await nativeExited;
  children.delete(native);
  console.log(
    "PASS: native new/fork/switch isolation, tree navigation refusal, command/callback compaction and Stop recovery, same-file reload/reload failure recovery, dynamic MCP collision and steer command ownership.",
  );
  assert(output.some((text) => text.startsWith("Pi session usage:")));
  console.log(
    "PASS: ACP executable, stdio MCP text/image/error/structured results, MCP cancel/resume/cleanup, unsupported transport refusal, file tool, input command, elicitation cancellation, stats, tool cancellation, process-tree signal shutdown, native restart/resume, failed replacement isolation and recovery.",
  );
  console.log(`Synthetic artifacts: ${root}`);
} finally {
  for (const child of children) child.kill();
  if (processPid)
    try {
      process.kill(-processPid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  if (piPid)
    try {
      process.kill(-piPid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
}
