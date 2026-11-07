import { RequestError } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

export const WORKSPACE_CONFIG_ENV = "LODY_PI_WORKSPACE_CONFIG";

const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0"),
    "Workspace paths must be absolute",
  );
const systemPromptSchema = z.object({
  mode: z.enum(["append", "override"]),
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1),
});
const workspaceSchema = z.object({
  cwd: absolutePath,
  additionalDirectories: z.array(absolutePath).optional(),
  systemPrompt: systemPromptSchema.nullish(),
});
export type Workspace = {
  cwd: string;
  additionalDirectories: string[];
  systemPrompt?: z.infer<typeof systemPromptSchema>;
};

/** Each activation supplies the whole request-owned list; omission clears it. */
export function validateWorkspace(input: unknown): Workspace {
  const result = workspaceSchema.safeParse(input);
  if (!result.success)
    throw RequestError.invalidParams(
      undefined,
      "Invalid workspace or systemPrompt: expected absolute directories and append/override with nonempty text content",
    );
  const parsed = result.data;
  return {
    cwd: normalize(parsed.cwd),
    ...(parsed.systemPrompt ? { systemPrompt: parsed.systemPrompt } : {}),
    additionalDirectories: [
      ...new Set((parsed.additionalDirectories ?? []).map(normalize)),
    ],
  };
}

/** Private runtime bridge, read once per native extension activation. */
export function readWorkspace(): Workspace {
  const file = process.env[WORKSPACE_CONFIG_ENV];
  if (!file) throw new Error("Missing Lody Pi workspace configuration");
  return validateWorkspace(JSON.parse(readFileSync(file, "utf8")));
}

export function workspaceContext(workspace: Workspace): string {
  return [
    "ACP workspace directories",
    JSON.stringify({
      cwd: workspace.cwd,
      additionalDirectories: workspace.additionalDirectories,
    }),
    "cwd is the primary working directory and the base for relative paths. The additional directories are also part of this activation's workspace; use absolute paths to access them with native file tools or bash. This list supplies workspace context, not a sandbox or a change to Pi's permissions. Existing user configuration remains in effect.",
  ].join("\n");
}
