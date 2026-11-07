import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childContext from "../src/child-context.js";
import { WORKSPACE_CONFIG_ENV } from "../src/workspace.js";

it("adds a child workspace snapshot while preserving native user prompt and registering no tools", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-child-context-"));
  const file = join(directory, "workspace.json");
  const workspace = {
    cwd: directory,
    additionalDirectories: [join(directory, "A")],
  };
  const on = vi.fn();
  const registerTool = vi.fn();
  const previous = process.env[WORKSPACE_CONFIG_ENV];
  try {
    writeFileSync(file, JSON.stringify(workspace));
    process.env[WORKSPACE_CONFIG_ENV] = file;
    childContext({ on, registerTool } as unknown as ExtensionAPI);
    writeFileSync(
      file,
      JSON.stringify({ cwd: directory, additionalDirectories: [] }),
    );
    const [event, handler] = on.mock.calls[0];
    expect(event).toBe("before_agent_start");
    const result = handler({ systemPrompt: "native user configuration" });
    expect(result.systemPrompt).toContain("native user configuration");
    expect(result.systemPrompt).toContain(JSON.stringify(workspace));
    expect(result.systemPrompt).toContain("do not ask the user");
    expect(registerTool).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env[WORKSPACE_CONFIG_ENV];
    else process.env[WORKSPACE_CONFIG_ENV] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

vi.mock("../src/mcp.js", () => ({ registerMcpTools: async () => {} }));
vi.mock("../src/builtin-tools.js", () => ({ registerBuiltinTools: () => {} }));
vi.mock("../src/subagents.js", () => ({
  registerSubagents: () => async () => ({}),
}));

it("applies client instructions to the native root prompt without leaking them into workspace JSON", async () => {
  const { default: extension } = await import("../src/extension.js");
  const directory = mkdtempSync(join(tmpdir(), "pi-root-context-"));
  const file = join(directory, "workspace.json");
  const previous = process.env[WORKSPACE_CONFIG_ENV];
  const on = vi.fn();
  try {
    process.env[WORKSPACE_CONFIG_ENV] = file;
    const write = (mode: string, text: string) =>
      writeFileSync(
        file,
        JSON.stringify({
          cwd: directory,
          additionalDirectories: [],
          systemPrompt: { mode, content: [{ type: "text", text }] },
        }),
      );
    write("append", "Client instruction");
    await extension({
      on,
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    const handler = on.mock.calls.find(
      ([event]) => event === "before_agent_start",
    )![1];
    const appended = handler({
      systemPrompt: "Native instructions",
    }).systemPrompt;
    expect(appended).toContain("Native instructions");
    expect(appended.match(/Client instruction/g)).toHaveLength(1);
    write("override", "Replacement instructions");
    const replaced = handler({
      systemPrompt: "Native instructions",
    }).systemPrompt;
    expect(replaced).toContain("Replacement instructions");
    expect(replaced).not.toContain("Native instructions");
    expect(replaced).not.toContain("Client instruction");
    expect(replaced).toContain(directory);
  } finally {
    if (previous === undefined) delete process.env[WORKSPACE_CONFIG_ENV];
    else process.env[WORKSPACE_CONFIG_ENV] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
