import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import spawn from "cross-spawn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_PATH_ENV } from "../src/launch.js";
import { registerSubagents } from "../src/subagents.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

class Child extends EventEmitter {
  pid = 1000 + children.length;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  closed = false;
  kill = (signal: string = "SIGTERM") => {
    this.signals.push(signal);
    return true;
  };

  constructor() {
    super();
    const maybeClose = () => {
      if (
        (this.exitCode !== null || this.signalCode !== null) &&
        this.stdout.destroyed &&
        this.stderr.destroyed
      )
        this.close(this.exitCode, this.signalCode);
    };
    this.stdout.on("close", maybeClose);
    this.stderr.on("close", maybeClose);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.destroy();
    this.stderr.destroy();
    this.emit("close", code, signal);
  }
}

const children: Child[] = [];
const executions: Promise<unknown>[] = [];

function harness() {
  let tool!: ToolDefinition;
  let shutdown!: () => Promise<void>;
  const events: unknown[] = [];
  const pi = {
    on: (name: string, handler: () => Promise<void>) => {
      if (name === "session_shutdown") shutdown = handler;
    },
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const control = registerSubagents(pi, (_ctx, event) => events.push(event));
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
  } as ExtensionContext;
  const run = (input: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = tool.execute(
      "call-test",
      { task: "Review a synthetic fixture", description: "review", ...input },
      signal,
      undefined,
      ctx,
    );
    executions.push(result);
    return result;
  };
  return { run, control, events, shutdown };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv(PI_PATH_ENV, process.execPath);
  vi.mocked(spawn).mockImplementation((command, args) => {
    if (String(command).endsWith("taskkill.exe")) {
      const pid = Number(args![args!.indexOf("/pid") + 1]);
      children
        .find((child) => child.pid === pid)!
        .kill(args!.includes("/F") ? "SIGKILL" : "SIGTERM");
      return new EventEmitter() as ChildProcess;
    }
    const child = new Child();
    children.push(child);
    return child as unknown as ChildProcess;
  });
});

afterEach(async () => {
  for (const child of children) child.close();
  await Promise.allSettled(executions);
  children.length = 0;
  executions.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("subagent execution deadlines", () => {
  it("stops a stalled child and returns a timeout only after the child exits", async () => {
    const { run, events } = harness();
    const result = run({ timeoutSeconds: 2 });
    const child = children[0]!;
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);
    child.exit(null, "SIGKILL");
    // Node can deliver buffered data after exit, including after forced termination.
    expect(child.stdout.destroyed).toBe(false);
    expect(child.stderr.destroyed).toBe(false);
    child.stdout.write(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Final buffered reply",
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          provider: "test",
          model: "model",
          responseId: "last-response",
          timestamp: 123,
          usage: { input: 1, output: 2 },
        },
      }) + "\n",
    );
    child.stderr.write("Final stderr");
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(child.stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringMatching(
            /timed out after 2 seconds[\s\S]*Final buffered reply[\s\S]*Final stderr/,
          ),
        },
      ],
      details: { status: "failed", isError: true },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "lody_usage",
        message: expect.objectContaining({
          responseId: "last-response",
          usage: { input: 1, output: 2 },
        }),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "lody_subagent",
      state: "failed",
      task: { status: "failed", error: expect.stringContaining("timed out") },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases inherited output pipes at the deadline after the child already exited", async () => {
    const { run } = harness();
    const result = run({ timeoutSeconds: 2 });
    const child = children[0]!;
    child.exit(0);
    expect(child.stdout.destroyed).toBe(false);
    expect(child.stderr.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    // Preserve output already buffered by the exited child during the drain grace.
    expect(child.stdout.destroyed).toBe(false);
    child.stdout.write(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Buffered result" },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    await expect(result).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Buffered result") }],
      details: { status: "failed", isError: true },
    });
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes as soon as pipes close during the drain grace and clears its timer", async () => {
    const { run, events } = harness();
    const result = run({ timeoutSeconds: 2 });
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(3000);
    child.exit(null, "SIGKILL");
    expect(child.stdout.destroyed).toBe(false);
    child.close(null, "SIGKILL");
    await expect(result).resolves.toMatchObject({
      details: { status: "failed" },
    });
    expect(vi.getTimerCount()).toBe(0);
    const eventCount = events.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(eventCount);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("applies the 30-minute default even when no timeout is supplied", async () => {
    const { run } = harness();
    const result = run();
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");
    await expect(result).resolves.toMatchObject({
      content: [
        { text: expect.stringContaining("timed out after 1800 seconds") },
      ],
      details: { status: "failed", isError: true },
    });
  });

  it.each([0, -1, 1.5, 86_401, NaN, Infinity, null, "2"])(
    "rejects an invalid deadline %s before spawning a child",
    async (timeoutSeconds) => {
      const { run } = harness();
      await expect(run({ timeoutSeconds })).rejects.toThrow();
      expect(children).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps a user cancellation distinct when the original deadline later passes", async () => {
    const { run } = harness();
    const controller = new AbortController();
    const result = run({ timeoutSeconds: 2 }, controller.signal);
    const child = children[0]!;
    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.exit(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({
      content: [{ text: "Cancelled" }],
      details: { status: "killed", isError: true },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves partial output and does not turn a late successful reply into success", async () => {
    const { run } = harness();
    const result = run({ timeoutSeconds: 2 });
    const child = children[0]!;
    child.stdout.write(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Partial findings",
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(2000);
    child.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }) + "\n",
    );
    child.exit(0);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({
      content: [
        {
          text: expect.stringMatching(
            /timed out after 2 seconds\nPartial findings/,
          ),
        },
      ],
      details: { status: "failed", isError: true },
    });
  });

  it("shares cancellation cleanup across timeout, task control and session shutdown", async () => {
    const { run, control, shutdown, events } = harness();
    const result = run({ timeoutSeconds: 2 });
    const child = children[0]!;
    const listed = await control({ op: "list" });
    const taskId = listed.tasks![0]!.taskId;
    await vi.advanceTimersByTimeAsync(2000);
    const cancelled = control({ op: "cancel", taskId });
    const stopped = shutdown();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.exit(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([result, cancelled, stopped]);
    expect(
      events.filter(
        (event) => (event as { state?: string }).state === "failed",
      ),
    ).toHaveLength(1);
    expect(await control({ op: "list" })).toEqual({ tasks: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timers on success and permits another invocation after a timeout", async () => {
    const { run } = harness();
    const first = run({ timeoutSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    children[0]!.close(null, "SIGTERM");
    await expect(first).resolves.toMatchObject({
      details: { status: "failed" },
    });
    expect(vi.getTimerCount()).toBe(0);

    const second = run({ timeoutSeconds: 1 });
    children[1]!.close(0);
    await expect(second).resolves.toMatchObject({
      details: { status: "completed", isError: false },
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(children[1]!.signals).toEqual([]);
  });

  it("clears the deadline when the child fails to spawn", async () => {
    const { run } = harness();
    const result = run({ timeoutSeconds: 2 });
    children[0]!.emit("error", new Error("spawn ENOENT"));
    children[0]!.close(-2);
    await expect(result).resolves.toMatchObject({
      content: [{ text: "spawn ENOENT" }],
      details: { status: "failed", isError: true },
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(children[0]!.signals).toEqual([]);
  });

  it("does not start work when the parent was already cancelled", async () => {
    const { run } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(run({}, controller.signal)).rejects.toThrow(
      "cancelled before launch",
    );
    expect(children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a provider failure that occurs before the deadline", async () => {
    const { run } = harness();
    const result = run({ timeoutSeconds: 2 });
    children[0]!.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Provider failed",
        },
      }) + "\n",
    );
    children[0]!.close(1);
    await expect(result).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Provider failed") }],
      details: { status: "failed", isError: true },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
