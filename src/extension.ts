import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { MCP_SERVERS_SECTION, registerMcp } from "./mcp.js";
import { registerBuiltinTools } from "./builtin-tools.js";
import { registerSubagents } from "./subagents.js";
import { readWorkspace, workspaceContext } from "./workspace.js";
/** Loaded inside Pi. Identity travels as native custom-message metadata, never model text. */
type Content = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;
type Context = {
  isIdle(): boolean;
  ui: { notify(message: string, type: "info"): void };
  sessionManager: { getSessionFile(): string | undefined };
};
export default async function lodyExtension(pi: ExtensionAPI): Promise<void> {
  const emit = (ctx: Context, event: unknown) =>
    ctx.ui.notify("lody-rpc:" + JSON.stringify(event), "info");
  // A private invocation per loaded runtime avoids sharing the public command namespace.
  const command = `lody-steer-${randomUUID()}`;
  // MCP adds its `mcp_servers` section before the workspace handler renders the prompt.
  registerMcp(pi);
  pi.on("before_agent_start", (event) => {
    const workspace = readWorkspace();
    const instructions = workspace.systemPrompt;
    const text = instructions?.content.map((block) => block.text).join("\n\n");
    // An override replaces Pi's prompt, but the model still needs runtime context:
    // the deferred MCP servers it can reach and the ACP workspace directories.
    const mcpServers = event.systemPromptOptions.sections[MCP_SERVERS_SECTION];
    const prompt =
      instructions?.mode === "override"
        ? [
            text!,
            mcpServers &&
              `<${MCP_SERVERS_SECTION}>\n${mcpServers}\n</${MCP_SERVERS_SECTION}>`,
          ]
            .filter(Boolean)
            .join("\n\n")
        : [event.systemPrompt, text]
            .filter((part) => part !== undefined)
            .join("\n\n");
    return { systemPrompt: `${prompt}\n\n${workspaceContext(workspace)}` };
  });
  registerBuiltinTools(pi, emit);
  const subagent = registerSubagents(pi, emit);
  pi.on("session_before_tree", (_event, ctx) => {
    ctx.ui.notify(
      "Native tree navigation is not supported through ACP; the current branch is unchanged.",
      "warning",
    );
    return { cancel: true };
  });
  pi.on("session_shutdown", (_event, ctx) => {
    emit(ctx, { type: "lody_not_ready" });
  });
  pi.on("session_start", (_event, ctx) => {
    emit(ctx, {
      type: "lody_steer_ready",
      version: 1,
      command,
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
  });
  pi.on("agent_settled", (_event, ctx) => {
    const turnId = ctx.sessionManager.getLeafId();
    if (turnId) emit(ctx, { type: "lody_turn_boundary", turnId });
  });
  pi.registerCommand(command, {
    description: "Lody internal steering transport",
    async handler(args, ctx) {
      const control = JSON.parse(args) as {
        op?: string;
        id?: string;
        taskId?: string;
      };
      if (control.op && control.id) {
        try {
          const data = await subagent({ ...control, op: control.op });
          emit(ctx, { type: "lody_control", id: control.id, data });
        } catch (error) {
          emit(ctx, {
            type: "lody_control",
            id: control.id,
            error: String(error),
          });
        }
        return;
      }
      const request = JSON.parse(args) as { steerId: string; content: Content };
      if (
        typeof request.steerId !== "string" ||
        !Array.isArray(request.content)
      )
        throw new Error("Invalid Lody steer request");
      // No await between this check and insertion. An idle session must refuse rather
      // than silently store input for some future prompt or start an unowned run.
      if (ctx.isIdle()) {
        emit(ctx, { type: "lody_steer_refused", steerId: request.steerId });
        return;
      }
      pi.sendMessage(
        {
          customType: "lody-steer",
          content: request.content,
          display: true,
          details: { steerId: request.steerId },
        },
        { deliverAs: "steer" },
      );
    },
  });
}
