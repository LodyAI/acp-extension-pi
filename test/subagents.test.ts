import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PI_PATH_ENV } from "../src/launch.js";
import { registerSubagents } from "../src/subagents.js";

type SubagentTool = ToolDefinition & {
  execute: (
    parentToolCallId: string,
    input: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};

// A fake Pi that records the argv it receives, then exits. Mirrors how npm
// installs Pi: a `.cmd` shim on Windows, an executable script elsewhere.
function createRecorderShim(directory: string): string {
  writeFileSync(
    join(directory, "recorder.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      "writeFileSync(process.env.RECORDER_OUT, JSON.stringify(process.argv.slice(2)));\n",
  );

  if (process.platform === "win32") {
    const shimPath = join(directory, "recorder.cmd");
    writeFileSync(
      shimPath,
      `@echo off\r\n"${process.execPath}" "%~dp0recorder.mjs" %*\r\n`,
    );
    return shimPath;
  }

  const shimPath = join(directory, "recorder.sh");
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/recorder.mjs" "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

describe("registerSubagents", () => {
  it("passes the raw task text to the child process without shell interpolation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-test-"));
    const shimPath = createRecorderShim(directory);
    const outputPath = join(directory, "argv.json");

    let tool: SubagentTool | undefined;
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((definition: SubagentTool) => {
        tool = definition;
      }),
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI;

    registerSubagents(pi, () => {});
    expect(tool).toBeDefined();

    const previousPath = process.env[PI_PATH_ENV];
    const previousOut = process.env.RECORDER_OUT;
    process.env[PI_PATH_ENV] = shimPath;
    process.env.RECORDER_OUT = outputPath;

    try {
      const task = "Please explain why %PATH% is different here & echo PWNED";
      await tool!.execute(
        "call-1",
        { task, description: "test" },
        undefined,
        undefined,
        {
          model: { provider: "test", id: "model" },
          cwd: directory,
        } as unknown as ExtensionContext,
      );

      const recorded = JSON.parse(readFileSync(outputPath, "utf8")) as string[];
      expect(recorded).toContain(task);
    } finally {
      if (previousPath === undefined) delete process.env[PI_PATH_ENV];
      else process.env[PI_PATH_ENV] = previousPath;
      if (previousOut === undefined) delete process.env.RECORDER_OUT;
      else process.env.RECORDER_OUT = previousOut;
    }
  });
});
