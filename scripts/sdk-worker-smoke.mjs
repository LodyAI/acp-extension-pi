import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { PiTransport } from "../dist/transport.js";

const root = await mkdtemp(join(tmpdir(), "pi-owned-worker-"));
const config = join(root, "mcp.json");
await writeFile(config, "[]");
await mkdir(join(root, "profile", "extensions"), { recursive: true });
await mkdir(join(root, ".pi", "extensions"), { recursive: true });
await writeFile(
  join(root, "profile", "extensions", "trust.ts"),
  `
export default pi => {
  console.log("synthetic global startup diagnostic");
  pi.on("project_trust", () => ({ trusted: process.env.SDK_TRUST }));
};
`,
);
await writeFile(
  join(root, ".pi", "extensions", "project.ts"),
  `
import { writeFileSync } from "node:fs";
export default () => {
  console.log("synthetic project startup diagnostic");
  writeFileSync("project-loaded", "yes");
};
`,
);
const start = (trust) =>
  spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
      "--provider",
      "lody-fixture",
      "--model",
      "fixture",
      "--no-skills",
      "--no-context-files",
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
        LODY_PI_MCP_CONFIG: config,
        SDK_TRUST: trust,
      },
    },
  );
const denied = start("no");
denied.stderr.pipe(process.stderr);
try {
  const deniedRpc = new PiTransport(
    {
      writable: Writable.toWeb(denied.stdin),
      readable: Readable.toWeb(denied.stdout),
    },
    async () => {},
    () => {},
  );
  await deniedRpc.request("get_state");
  await assert.rejects(access(join(root, "project-loaded")), {
    code: "ENOENT",
  });
} finally {
  const exited = once(denied, "exit", { signal: AbortSignal.timeout(15000) });
  denied.kill("SIGTERM");
  await exited;
}
const child = start("yes");
child.stderr.pipe(process.stderr);
const watchdog = setTimeout(() => {
  child.kill("SIGKILL");
  throw Error("SDK worker watchdog");
}, 15000);
const rpc = new PiTransport(
  {
    writable: Writable.toWeb(child.stdin),
    readable: Readable.toWeb(child.stdout),
  },
  async () => {},
  () => {},
);
function ready(key) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        await readFile(join(root, `sdk-ready-${key}`));
        watcher.close();
        resolve();
      } catch (error) {
        if (error.code !== "ENOENT") {
          watcher.close();
          reject(error);
        }
      }
    };
    const watcher = watch(root, check);
    void check();
  });
}
try {
  await rpc.request("get_state");
  await access(join(root, "project-loaded"));
  for (const cancel of [false, true]) {
    const key = cancel ? "cancel" : "success";
    const entered = ready(key);
    let completed = false,
      aborted = false;
    const prompt = rpc
      .request("prompt", { message: `sdk followup preflight ${key}` })
      .then((value) => {
        completed = true;
        return value;
      });
    await entered;
    // A round trip on the same worker wire is an ordering barrier, not a sleep.
    await rpc.request("get_state");
    assert.equal(
      completed,
      false,
      "child preflight must hold the worker response",
    );
    const abort = cancel
      ? rpc.request("abort").then(() => {
          aborted = true;
        })
      : Promise.resolve();
    await rpc.request("get_state");
    if (cancel)
      assert.equal(aborted, false, "Stop must still own blocked preflight");
    await writeFile(join(root, `sdk-release-${key}`), "yes");
    await Promise.all([prompt, abort]);
    if (cancel)
      await assert.rejects(access(join(root, `sdk-provider-${key}`)), {
        code: "ENOENT",
      });
    else await access(join(root, `sdk-provider-${key}`));
    await rpc.request("prompt", { message: "recovery" });
  }
  const entered = ready("disconnect");
  const prompt = rpc.request("prompt", {
    message: "sdk followup preflight disconnect",
  });
  const rejected = assert.rejects(prompt, /closed/);
  await entered;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await rejected;
  await assert.rejects(access(join(root, "sdk-provider-disconnect")), {
    code: "ENOENT",
  });
  console.log(
    "PASS: SDK worker owns gated follow-up, preflight Stop, recovery and process shutdown.",
  );
} finally {
  clearTimeout(watchdog);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
