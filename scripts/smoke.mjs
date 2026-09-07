import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
const root = await mkdtemp(join(tmpdir(), "acp-pi-smoke-"));
const children = new Set();
let toolStarted;
const output = [];
async function start(id) {
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
      unstable_createElicitation: async () => ({ action: "cancel" }),
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
        { name: "unsupported", command: "unused", args: [], env: [] },
      ],
    }),
    /MCP/,
  );
  const session = id
    ? await client.resumeSession({ cwd: root, sessionId: id, mcpServers: [] })
    : await client.newSession({ cwd: root, mcpServers: [] });
  return {
    client,
    id: session.sessionId ?? id,
    async stop() {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
      children.delete(child);
    },
  };
}
try {
  const a = await start();
  const prompt = (text) =>
    a.client.prompt({ sessionId: a.id, prompt: [{ type: "text", text }] });
  assert.equal((await prompt("write fixture")).stopReason, "end_turn");
  assert.equal(
    await readFile(join(root, "fixture.txt"), "utf8"),
    "native pi wrote this\n",
  );
  await prompt("handled fixture");
  await prompt("/ask-fixture");
  await prompt("/stats");
  const ready = new Promise((resolve) => {
    toolStarted = resolve;
  });
  const running = prompt("gate fixture");
  await ready;
  await a.client.cancel({ sessionId: a.id });
  assert.equal((await running).stopReason, "cancelled");
  await a.stop();
  const b = await start(a.id);
  assert.equal(b.id, a.id);
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
  assert.equal(
    (
      await b.client.prompt({
        sessionId: replacement.sessionId,
        prompt: [{ type: "text", text: "continue after failed setup" }],
      })
    ).stopReason,
    "end_turn",
  );
  const activeReady = new Promise((resolve) => {
    toolStarted = resolve;
  });
  const disconnected = b.client.prompt({
    sessionId: replacement.sessionId,
    prompt: [{ type: "text", text: "gate fixture" }],
  });
  const rejectedOnDisconnect = assert.rejects(disconnected);
  await activeReady;
  await b.stop();
  await rejectedOnDisconnect;
  assert(output.some((text) => text.startsWith("Pi session usage:")));
  console.log(
    "PASS: ACP executable, MCP refusal, file tool, input command, elicitation cancellation, stats, tool cancellation, active-tool stdin shutdown, native restart/resume, failed replacement isolation and recovery.",
  );
  console.log(`Synthetic artifacts: ${root}`);
} finally {
  for (const child of children) child.kill();
}
