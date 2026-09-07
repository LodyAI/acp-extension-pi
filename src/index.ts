#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { serve } from "./server.js";
const server = serve(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  process.argv.slice(2),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
