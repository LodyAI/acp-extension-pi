# acp-extension-pi

Standalone public ACP adapter. Lody consumes its executable; never import Lody
workspace packages or reimplement Pi's executor.

- Launch the pinned official Pi CLI in RPC mode. There is no custom SDK worker,
  AgentSession facade, generic call owner or background execution scheduler.
- Disable extension discovery and refuse external extension startup arguments.
  Only the packaged extension is loaded. Child Pi processes disable discovery too.
  This is a supported-feature boundary, not a sandbox against arbitrary bash.
- Packaged tools are questionnaire, todo, subagent and ACP-selected stdio MCP
  tools. Their execute promises own all work. No detached callbacks, hot reload,
  extension-driven session replacement or custom compaction.
- Only the main agent asks questions. Questionnaire handles one or many questions
  through Lody form elicitation. Stop closes questions; late answers cannot enter
  another request. Do not implement terminal UI.
- Todo snapshots live in Pi tool results. Reconstruct on native resume and publish
  ACP checklist updates to Lody; never create another todo store or bidirectional sync.
- Subagent execution owns task ids, status, output and child cancellation. Lody
  receives Core task metadata and list/output/cancel methods. Parent tools await
  child exit; child agents have built-in Pi tools, no questionnaire or subagent
  extension. They inherit model, thinking and cwd, not the parent's MCP clients.
  Process-local task queries do not resume or replay a terminated child.
- Ordinary prompt ACK means preflight passed, not completion. With only these
  packaged tools, agent_settled terminates native model work including retries and
  automatic compaction. Explicit compact waits for its own RPC response. Both
  drain output and finish cleanup before admitting another request.
- Abort must not overtake prompt preflight. Clear queues, cancel questions, await
  native abort and the same request cleanup. Transport failure is failure, never
  successful settlement. Never silently retry a prompt.
- Pi owns native session files. ACP identity is the native file path. Explicit
  new/resume and configuration exclude execution. Never silently follow another
  file or branch. Do not replay Lody history or add an identity map.
- Steering uses native custom-message metadata, never matching text. Emit the Core
  applied notification before later output; Lody owns its application barrier.
- Keep diagnostics separate from model outcomes. Preserve native error, length
  and cancellation results. Pi stats own usage and context occupancy.
- stdout is protocol only; diagnostics go to stderr. Close the owned process tree
  when ACP closes. Subagents stay in the Pi process group for forced cleanup.
- MCP names use the reserved mcp_ prefix and must be unique after normalization.
  Preserve rich results, error flags and cancellation. Configuration secrets stay
  in private temporary files, never native history.
- Use acp-extension-core contracts. Advertise only implemented capabilities.
  No permission modes, arbitrary plugin compatibility, TUI, Plan Mode, runtime
  preset/tools plugins, detached subagent jobs or native history import in V1.
- Tests use synthetic inputs and explicit signals, no real sleeps or commercial
  providers. Unit tests protect wire contracts; smoke drives the official CLI
  through a local deterministic model endpoint without injecting a provider plugin.

Implementation changes use a Draft PR. Before committing run pnpm check,
pnpm build and pnpm smoke. Verify installed tarball behavior for packaging changes.
Remove replaced production paths and their implementation-only tests together.
