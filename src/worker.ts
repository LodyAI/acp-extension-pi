import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  parseArgs,
  ProjectTrustStore,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type ProjectTrustContext,
  type ProjectTrustEventResult,
} from "@earendil-works/pi-coding-agent";
import { ownRuntime } from "./native-host.js";

const args = parseArgs(process.argv.slice(2));
for (const diagnostic of args.diagnostics) {
  if (diagnostic.type === "error") throw new Error(diagnostic.message);
  process.stderr.write(`${diagnostic.message}\n`);
}
if (args.offline) {
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
}
const agentDir = getAgentDir();
const initialCwd = process.cwd();
const absolute = (paths: string[] | undefined) =>
  paths?.map((path) => resolve(initialCwd, path));
const trustStore = new ProjectTrustStore(agentDir);

// Match native headless trust: user/global extensions may decide before any
// project-local settings, packages or extensions are allowed to load.
const createRuntime = () =>
  createAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }) => {
      const needsTrust = hasTrustRequiringProjectResources(cwd);
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted: !needsTrust || args.projectTrustOverride === true,
      });
      const trustContext: ProjectTrustContext = {
        cwd,
        mode: "rpc",
        hasUI: false,
        ui: {
          select: async () => undefined,
          confirm: async () => false,
          input: async () => undefined,
          notify: (message) => {
            process.stderr.write(`${message}\n`);
          },
        },
      };
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        extensionFlagValues: args.unknownFlags,
        modelRuntimeSignal: AbortSignal.timeout(15000),
        resourceLoaderOptions: {
          additionalExtensionPaths: [
            ...(absolute(args.extensions) ?? []),
            fileURLToPath(new URL("./extension.js", import.meta.url)),
          ],
          additionalSkillPaths: absolute(args.skills),
          additionalPromptTemplatePaths: absolute(args.promptTemplates),
          additionalThemePaths: absolute(args.themes),
          noExtensions: args.noExtensions,
          noSkills: args.noSkills,
          noPromptTemplates: args.noPromptTemplates,
          noThemes: args.noThemes,
          noContextFiles: args.noContextFiles,
          systemPrompt: args.systemPrompt,
          appendSystemPrompt: args.appendSystemPrompt,
        },
        resourceLoaderReloadOptions: needsTrust
          ? {
              resolveProjectTrust: async ({ extensionsResult }) => {
                if (args.projectTrustOverride !== undefined)
                  return args.projectTrustOverride;
                for (const extension of extensionsResult.extensions) {
                  for (const handler of extension.handlers.get(
                    "project_trust",
                  ) ?? []) {
                    try {
                      const result = await (
                        handler as (
                          event: { type: "project_trust"; cwd: string },
                          ctx: ProjectTrustContext,
                        ) => Promise<ProjectTrustEventResult | undefined>
                      )({ type: "project_trust", cwd }, trustContext);
                      if (result && result.trusted !== "undecided") {
                        const trusted = result.trusted === "yes";
                        if (result.remember) trustStore.set(cwd, trusted);
                        return trusted;
                      }
                    } catch (error) {
                      process.stderr.write(
                        `Pi project trust: ${String(error)}\n`,
                      );
                    }
                  }
                }
                return (
                  trustStore.get(cwd) ??
                  settingsManager.getDefaultProjectTrust() === "always"
                );
              },
            }
          : undefined,
      });
      for (const diagnostic of services.diagnostics) {
        if (diagnostic.type === "error") throw new Error(diagnostic.message);
        process.stderr.write(`${diagnostic.message}\n`);
      }
      const extensionErrors = services.resourceLoader.getExtensions().errors;
      if (extensionErrors.length)
        throw new Error(
          extensionErrors
            .map(
              ({ path, error }) =>
                `Failed to load extension "${path}": ${error}`,
            )
            .join("\n"),
        );
      const selected = resolveCliModel({
        cliProvider: args.provider,
        cliModel: args.model,
        cliThinking: args.thinking,
        modelRuntime: services.modelRuntime,
      });
      if (selected.error) throw new Error(selected.error);
      if (selected.warning) process.stderr.write(`${selected.warning}\n`);
      if (args.apiKey) {
        if (!selected.model) throw new Error("--api-key requires a model");
        await services.modelRuntime.setRuntimeApiKey(
          selected.model.provider,
          args.apiKey,
        );
      }
      const patterns = args.models ?? settingsManager.getEnabledModels();
      const scopedModels = patterns?.length
        ? (
            await resolveModelScopeWithDiagnostics(
              patterns,
              services.modelRuntime,
            )
          ).scopedModels
        : [];
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: selected.model,
        thinkingLevel: args.thinking ?? selected.thinkingLevel,
        scopedModels,
        tools: args.tools,
        excludeTools: args.excludeTools,
        noTools: args.noTools
          ? "all"
          : args.noBuiltinTools
            ? "builtin"
            : undefined,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    {
      cwd: initialCwd,
      agentDir,
      sessionManager: SessionManager.create(initialCwd, args.sessionDir),
    },
  );

// Let Pi install its stdout guard before loading any user extension. The first
// awaited binding initializes the SDK; all later access uses the real host.
let host: AgentSessionRuntime | undefined;
let rebind: Parameters<AgentSessionRuntime["setRebindSession"]>[0];
const startupSession = new Proxy({} as AgentSession, {
  get(_target, key) {
    if (key === "bindExtensions")
      return async (
        bindings: Parameters<AgentSession["bindExtensions"]>[0],
      ) => {
        host ??= ownRuntime(await createRuntime());
        host.setRebindSession(rebind);
        await host.session.bindExtensions(bindings);
      };
    if (!host) throw new Error("Pi SDK is not initialized");
    const value = Reflect.get(host.session, key);
    return typeof value === "function" ? value.bind(host.session) : value;
  },
});
await runRpcMode(
  new Proxy({} as AgentSessionRuntime, {
    get(_target, key) {
      if (key === "session") return host?.session ?? startupSession;
      if (key === "setRebindSession")
        return (callback: typeof rebind) => {
          rebind = callback;
          host?.setRebindSession(callback);
        };
      if (!host) throw new Error("Pi SDK is not initialized");
      const value = Reflect.get(host, key);
      return typeof value === "function" ? value.bind(host) : value;
    },
  }),
);
