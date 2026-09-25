import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

/** Read-only listing of Pi's native session files; never starts Pi or creates directories. */
export async function listPiSessions(
  request: acp.ListSessionsRequest,
): Promise<acp.ListSessionsResponse> {
  const { SessionManager, SettingsManager, getAgentDir } =
    await import("@earendil-works/pi-coding-agent");
  const cwd = request.cwd ?? process.cwd();
  // Same precedence as the Pi CLI started by this adapter (it passes no --session-dir).
  const sessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ||
    SettingsManager.create(cwd).getSessionDir();
  // Pi's default per-cwd directory; SessionManager.list would create it when missing.
  const directory = (candidate: string) =>
    sessionDir ??
    join(
      getAgentDir(),
      "sessions",
      `--${resolve(candidate)
        .replace(/^[/\\]/, "")
        .replace(/[/\\:]/g, "-")}--`,
    );
  // Pi records process.cwd(): symlink-resolved on POSIX, as spawned on Windows.
  const candidates = new Set([cwd, await realpath(cwd).catch(() => cwd)]);
  const sessions = request.cwd
    ? (
        await Promise.all(
          [...candidates].map((candidate) =>
            SessionManager.list(candidate, directory(candidate)),
          ),
        )
      ).flat()
    : await SessionManager.listAll(sessionDir);
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  return {
    sessions: [...byPath.values()].map((session) => ({
      sessionId: session.path,
      cwd: session.cwd || cwd,
      title: session.name || session.firstMessage || null,
      updatedAt: session.modified.toISOString(),
    })),
  };
}
