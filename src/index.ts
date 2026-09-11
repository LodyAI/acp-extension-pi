#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { serve } from "./server.js";
// Own the OS process tree before Pi (or any descendant) can start.
if (process.platform === "win32") {
  createRequire(import.meta.url)(`../native/win32-${process.arch}.node`).join();
}
const server = serve(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  process.argv.slice(2),
);
void server.closed.then(() => process.exit(process.exitCode ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
