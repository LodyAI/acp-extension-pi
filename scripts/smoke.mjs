import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { LODY_EXTENSION_METHODS } from "acp-extension-core";

// Real official CLI and packaged extensions, with a local deterministic model.
// No injected provider plugin or alternate runtime implementation.
const root = await mkdtemp(join(tmpdir(), "pi-v1-smoke-"));
const profile = join(root, "profile");
await mkdir(join(profile, "extensions"), { recursive: true });
await mkdir(join(root, ".pi", "extensions"), { recursive: true });
const marker = join(root, "external-loaded");
const external = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function() {}`;
await writeFile(join(profile, "extensions", "unwanted.ts"), external);
await writeFile(join(root, ".pi", "extensions", "unwanted.ts"), external);
const bodies = [];
let childRequest;
let releaseChild;
const heldChild = new Promise((resolve) => {
  childRequest = resolve;
});
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  bodies.push(body);
  const user = [...body.messages]
    .reverse()
    .find((message) => message.role === "user");
  const content =
    typeof user?.content === "string"
      ? user.content
      : (user?.content ?? []).map((block) => block.text ?? "").join("\n");
  const last = body.messages.at(-1);
  let tool;
  if (last?.role !== "tool") {
    if (content.includes("ASK_TEST"))
      tool = [
        "questionnaire",
        {
          questions: [
            {
              id: "scope",
              question: "Choose scope",
              options: [{ label: "Small" }, { label: "Large" }],
            },
            { id: "note", question: "Any note?" },
          ],
        },
      ];
    if (content.includes("TODO_TEST"))
      tool = ["todo", { action: "add", text: "Verify native adapter" }];
    if (content.includes("CLEAR_TODO")) tool = ["todo", { action: "clear" }];
    if (content.includes("MCP_TEST"))
      tool = ["mcp_fixture_echo", { value: "native-mcp" }];
    if (content.includes("MCP_ERROR")) tool = ["mcp_fixture_error", {}];
    if (content.includes("MCP_IMAGE")) tool = ["mcp_fixture_image", {}];
    if (content.includes("MCP_RESOURCE"))
      tool = ["mcp_fixture_echo", { value: "unsupported-resource" }];
    if (content.includes("SUB_TEST"))
      tool = [
        "subagent",
        { task: "CHILD_TEST", description: "Inspect child task" },
      ];
    if (content.includes("CANCEL_SUB"))
      tool = [
        "subagent",
        { task: "CHILD_HOLD", description: "Cancelled child" },
      ];
  }
  if (content === "CHILD_HOLD") {
    releaseChild = response;
    childRequest();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (tool) {
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${bodies.length}`,
          type: "function",
          function: { name: tool[0], arguments: JSON.stringify(tool[1]) },
        },
      ],
    });
    chunk({}, "tool_calls");
  } else {
    chunk({
      role: "assistant",
      content: content === "CHILD_TEST" ? "CHILD_RESULT" : "DONE",
    });
    chunk({}, "stop");
  }
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
await writeFile(
  join(profile, "models.json"),
  JSON.stringify({
    providers: {
      localtest: {
        api: "openai-completions",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        models: [{ id: "fixture", contextWindow: 32000, maxTokens: 4096 }],
      },
    },
  }),
);
const children = new Set();
const updates = [];
let answer = async (request) => {
  assert.equal(Object.keys(request.requestedSchema.properties).length, 3);
  assert.ok(request.toolCallId);
  return { action: "accept", content: { q0: "Small", q1: "No extra scope" } };
};
const entry =
  process.argv[2] ??
  fileURLToPath(new URL("../dist/index.js", import.meta.url));
async function start(sessionId) {
  const child = spawn(
    process.execPath,
    [entry, "--provider", "localtest", "--model", "fixture"],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: profile,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  child.stderr.pipe(process.stderr);
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async ({ update }) => {
        updates.push(update);
      },
      unstable_createElicitation: (request) => answer(request),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      extNotification: async () => {},
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const init = await client.initialize({ protocolVersion: 1 });
  assert.equal(init.agentCapabilities._meta.lody.subagents.cancel, true);
  const mcpServers = [
    {
      name: "fixture",
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../test/fixtures/mcp.mjs", import.meta.url)),
      ],
      env: [{ name: "MCP_FIXTURE_TAG", value: "v1" }],
    },
  ];
  const result = sessionId
    ? await client.resumeSession({ sessionId, cwd: root, mcpServers })
    : await client.newSession({ cwd: root, mcpServers });
  const id = result.sessionId ?? sessionId;
  return {
    process: child,
    client,
    id,
    prompt: (text) =>
      client.prompt({ sessionId: id, prompt: [{ type: "text", text }] }),
    close: async () => {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
      children.delete(child);
    },
  };
}
const deadline = setTimeout(() => {
  for (const child of children) child.kill("SIGTERM");
  server.closeAllConnections();
  throw new Error("Native smoke did not converge");
}, 45000);
try {
  const a = await start();
  await a.prompt("MCP_TEST");
  assert.ok(
    updates.some((update) =>
      (JSON.stringify(update.rawOutput) ?? "").includes("MCP:v1:native-mcp"),
    ),
  );
  await a.prompt("MCP_ERROR");
  assert.ok(
    updates.some(
      (update) =>
        update.title === "mcp_fixture_error" && update.status === "failed",
    ),
  );
  await a.prompt("MCP_IMAGE");
  assert.ok(
    updates.some(
      (update) =>
        update.title === "mcp_fixture_image" &&
        update.status === "completed" &&
        update.content?.some(
          (block) => block.type === "content" && block.content.type === "image",
        ),
    ),
  );
  const beforeUnsupported = updates.length;
  await a.prompt("MCP_RESOURCE");
  assert.ok(
    updates
      .slice(beforeUnsupported)
      .some(
        (update) =>
          update.title === "mcp_fixture_echo" &&
          update.status === "failed" &&
          JSON.stringify(update.content).includes(
            "Unsupported MCP content type: resource_link",
          ),
      ),
  );
  assert.equal((await a.prompt("ASK_TEST")).stopReason, "end_turn");
  assert.ok(
    bodies.some((body) =>
      body.messages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes("No extra scope"),
      ),
    ),
  );
  await a.prompt("TODO_TEST");
  assert.ok(
    updates.some(
      (update) =>
        update.sessionUpdate === "plan" &&
        update.entries.some((item) => item.content === "Verify native adapter"),
    ),
  );
  await a.prompt("SUB_TEST");
  const listed = await a.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsList,
    { sessionId: a.id },
  );
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].status, "completed");
  const output = await a.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsOutput,
    { sessionId: a.id, taskId: listed.tasks[0].taskId },
  );
  assert.match(output.output, /CHILD_RESULT/);
  assert.ok(
    updates.some(
      (update) =>
        update._meta?.lody?.task?.taskId === listed.tasks[0].taskId &&
        update._meta.lody.task.status === "completed",
    ),
  );
  const running = a.prompt("CANCEL_SUB");
  await heldChild;
  assert.ok(
    updates.some(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        update._meta?.lody?.task?.description === "Cancelled child" &&
        update._meta.lody.task.status === "in_progress",
    ),
  );
  const active = await a.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsList,
    { sessionId: a.id, activeOnly: true },
  );
  assert.equal(active.tasks.length, 1);
  await a.client.extMethod(LODY_EXTENSION_METHODS.subagentsCancel, {
    sessionId: a.id,
    taskId: active.tasks[0].taskId,
  });
  releaseChild.destroy();
  await running;
  assert.equal(
    (
      await a.client.extMethod(LODY_EXTENSION_METHODS.subagentsList, {
        sessionId: a.id,
      })
    ).tasks.at(-1).status,
    "killed",
  );
  let asked;
  const questionSeen = new Promise((resolve) => {
    asked = resolve;
  });
  answer = async () => {
    asked();
    return new Promise(() => {});
  };
  const waiting = a.prompt("ASK_TEST");
  await questionSeen;
  await a.client.cancel({ sessionId: a.id });
  assert.equal((await waiting).stopReason, "cancelled");
  await a.prompt("RECOVER_TEST");
  const id = a.id;
  await a.close();
  const before = updates.length;
  const b = await start(id);
  assert.ok(
    updates
      .slice(before)
      .some(
        (update) =>
          update.sessionUpdate === "plan" &&
          update.entries.some(
            (item) => item.content === "Verify native adapter",
          ),
      ),
  );
  await b.prompt("CLEAR_TODO");
  assert.equal(
    updates.filter((update) => update.sessionUpdate === "plan").at(-1).entries
      .length,
    0,
  );
  const closingChild = new Promise((resolve) => {
    childRequest = resolve;
  });
  const interrupted = assert.rejects(b.prompt("CANCEL_SUB"));
  await closingChild;
  const childDisconnected = once(releaseChild, "close");
  await b.close();
  await Promise.all([interrupted, childDisconnected]);
  if (process.platform === "win32") {
    for (const crash of ["pi", "adapter"]) {
      const c = await start();
      const held = new Promise((resolve) => {
        childRequest = resolve;
      });
      const rejectedPrompt = assert.rejects(c.prompt("CANCEL_SUB"));
      await held;
      // Real Pi, MCP and subagent processes; the model request is held open.
      const rows = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8" },
        ),
      );
      const pi = rows.find((row) => row.ParentProcessId === c.process.pid);
      assert.ok(pi, "native Pi child found");
      const descendants = rows.filter(
        (row) => row.ParentProcessId === pi.ProcessId,
      );
      assert.ok(descendants.length >= 2, "MCP and native subagent are running");
      const exited = once(c.process, "exit");
      process.kill(crash === "pi" ? pi.ProcessId : c.process.pid, "SIGKILL");
      const [[code]] = await Promise.all([exited, rejectedPrompt]);
      if (crash === "pi")
        assert.equal(code, 1, "runtime crash fails the connection");
      children.delete(c.process);
      // Kernel process waits, not polling/sleep-based assertions.
      const pids = [pi.ProcessId, ...descendants.map((row) => row.ProcessId)];
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `
        $ErrorActionPreference = 'Stop'
        foreach ($processId in @(${pids.join(",")})) {
          $owned = Get-Process -Id $processId -ErrorAction SilentlyContinue
          if ($owned -and !$owned.WaitForExit(5000)) {
            $owned.Kill()
            throw "Descendant survived adapter exit: $processId"
          }
        }
        exit 0
      `,
        ],
        { stdio: "pipe" },
      );
      releaseChild.destroy();
      console.log(`PASS ${crash} crash cleans native descendants`);
    }
  }
  await assert.rejects(access(marker));
  const rejected = spawn(
    process.execPath,
    [entry, "-e", join(profile, "extensions", "unwanted.ts")],
    { cwd: root, stdio: "ignore" },
  );
  assert.notEqual((await once(rejected, "exit"))[0], 0);
  for (const body of bodies.filter((body) =>
    body.messages.some(
      (message) =>
        message.role === "user" &&
        ["CHILD_TEST", "CHILD_HOLD"].includes(message.content),
    ),
  )) {
    const names = body.tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(!names.includes("questionnaire") && !names.includes("subagent"));
  }
  console.log(
    "Native Pi V1 smoke passed: questions, todo/resume, subagent lifecycle/output/cancel, Stop/recovery, extension isolation",
  );
} finally {
  clearTimeout(deadline);
  for (const child of children) child.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
