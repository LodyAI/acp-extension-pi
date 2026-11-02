import { z } from "zod";

/** Pi's thinking levels, in `getSupportedThinkingLevels` order. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const modelCapabilitySchema = z.object({
  provider: z.string(),
  id: z.string(),
  reasoning: z.boolean(),
  thinkingLevelMap: z
    .record(z.string(), z.union([z.string(), z.null()]))
    .optional(),
});

type ModelCapability = z.infer<typeof modelCapabilitySchema>;
type ThinkingCapability = Pick<
  ModelCapability,
  "reasoning" | "thinkingLevelMap"
>;

/** Mirrors Pi's `getSupportedThinkingLevels`; null marks a level unsupported. */
export function supportedThinkingLevels(model: ThinkingCapability): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Builds `_meta.lody.modelCapabilities`, keyed by `provider/id`. */
export function buildModelCapabilitiesMeta(
  models: readonly ModelCapability[],
): Record<string, unknown> {
  return {
    lody: {
      modelCapabilities: {
        version: 1,
        models: Object.fromEntries(
          models.map((model): [string, { effortValues: string[] }] => [
            `${model.provider}/${model.id}`,
            { effortValues: supportedThinkingLevels(model) },
          ]),
        ),
      },
    },
  };
}
