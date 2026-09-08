import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpTools } from "./mcp.js";
/** Loaded inside Pi. Identity travels as native custom-message metadata, never model text. */
type Content = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;
type Context = {
  isIdle(): boolean;
  ui: { notify(message: string, type: "info"): void };
};
export default async function lodyExtension(pi: ExtensionAPI): Promise<void> {
  await registerMcpTools(pi);
  const emit = (ctx: Context, event: unknown) =>
    ctx.ui.notify("lody-rpc:" + JSON.stringify(event), "info");
  pi.on("session_start", (_event, ctx) => {
    emit(ctx, { type: "lody_steer_ready", version: 1 });
  });
  pi.registerCommand("lody-steer", {
    description: "Lody internal steering transport",
    async handler(args, ctx) {
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
