import { realpath } from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";

/** Read-only listing of Pi's native session files; never starts Pi. */
export async function listPiSessions(
  request: acp.ListSessionsRequest,
): Promise<acp.ListSessionsResponse> {
  const { SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  // Pi runs in, records and files sessions under the resolved working directory.
  const cwd = await realpath(request.cwd ?? process.cwd());
  // Same precedence as the Pi CLI started by this adapter (it passes no --session-dir).
  const sessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ||
    SettingsManager.create(cwd).getSessionDir();
  const sessions = request.cwd
    ? await SessionManager.list(cwd, sessionDir)
    : await SessionManager.listAll(sessionDir);
  return {
    sessions: sessions.map((session) => ({
      sessionId: session.path,
      cwd: session.cwd || cwd,
      title: session.name || session.firstMessage || null,
      updatedAt: session.modified.toISOString(),
    })),
  };
}
