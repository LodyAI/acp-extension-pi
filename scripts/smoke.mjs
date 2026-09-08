import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
const root = await mkdtemp(join(tmpdir(), "acp-pi-smoke-"));
const children = new Set();
let toolStarted;
let answerQuestion = async () => ({ action: "cancel" });
const output = [];
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
      fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "--provider",
      "lody-fixture",
      "--model",
      "fixture",
      "--no-extensions",
      "-e",
      fileURLToPath(new URL("../test/fixtures/provider.mjs", import.meta.url)),
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
      extNotification: async () => {},
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const info = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
  });
  assert.equal(info.agentCapabilities._meta.lody.steering.version, 1);
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

  await prompt("/stats");
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
