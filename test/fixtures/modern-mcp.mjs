import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(
  () => {
    const server = new McpServer({ name: "modern-only", version: "1" });
    server.registerTool(
      "echo",
      {
        description: "Synthetic modern echo",
        inputSchema: z.object({ value: z.string() }),
      },
      async ({ value }) => ({
        content: [{ type: "text", text: `modern:${value}` }],
      }),
    );
    return server;
  },
  { legacy: "reject" },
);
