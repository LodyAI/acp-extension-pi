import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPiSessions } from "../src/sessions.js";

const ENV = ["PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR"] as const;
const previous = ENV.map((name) => process.env[name]);
let directory: string | undefined;
afterEach(() => {
  ENV.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function session(name: string, cwd: string, lines: object[]) {
  const file = join(directory!, name);
  writeFileSync(
    file,
    [
      {
        type: "session",
        version: 3,
        id: name,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      },
      ...lines,
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return file;
}
const user = (id: string, content: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content, timestamp: 1 },
});

describe("native Pi session listing", () => {
  it("lists the configured directory's sessions for one resolved cwd by native file path", async () => {
    directory = realpathSync.native(
      mkdtempSync(join(tmpdir(), "lody-pi-sessions-")),
    );
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
    const work = join(directory, "work");
    mkdirSync(work);
    symlinkSync(work, join(directory, "link"));
    const first = session("first.jsonl", work, [user("u1", "fix the build")]);
    const named = session("named.jsonl", work, [
      user("u1", "hello"),
      {
        type: "session_info",
        id: "i1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        name: "Release prep",
      },
    ]);
    session("other.jsonl", directory, [user("u1", "unrelated")]);

    const { sessions } = await listPiSessions({
      cwd: join(directory, "link"),
    });

    expect(
      sessions
        .map(({ sessionId, cwd, title }) => ({ sessionId, cwd, title }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    ).toEqual([
      { sessionId: first, cwd: work, title: "fix the build" },
      { sessionId: named, cwd: work, title: "Release prep" },
    ]);
    expect(
      sessions.every((item) => !Number.isNaN(Date.parse(item.updatedAt!))),
    ).toBe(true);
  });

  it("lists Pi's default directory without creating it", async () => {
    directory = realpathSync.native(
      mkdtempSync(join(tmpdir(), "lody-pi-sessions-")),
    );
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);

    await expect(listPiSessions({ cwd: directory })).resolves.toEqual({
      sessions: [],
    });
    expect(readdirSync(process.env.PI_CODING_AGENT_DIR)).toEqual([]);
  });
});
