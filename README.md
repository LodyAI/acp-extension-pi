# Pi ACP adapter

A Lody-owned ACP adapter for the pinned official Pi CLI (0.85.1).

```text
Lody → ACP Adapter → official Pi CLI --mode rpc
                         └─ packaged tools
```

The adapter translates protocols. Pi owns model execution, native tools,
automatic compaction, retry and session files. There is no custom SDK worker.

## Run

Requires Node.js 22.19 or newer.

```sh
pnpm install
pnpm build
node dist/index.js --provider <provider> --model <model>
```

Startup accepts only --provider, --model and --thinking. Authenticate/configure
models through Pi on the execution machine. ACP configuration also exposes model
and thinking selection. stdout is ACP; stderr contains diagnostics.

External extensions are not supported. The adapter disables automatic discovery
and refuses user-supplied extension flags. Official example extensions are not
implicitly supported: only the implementation packaged here is loaded.
This restriction is not a security sandbox for shell commands.

## V1 capabilities

- Native prompts, text/images, tool progress/results, model errors and cancellation.
- Native file identity for explicit new/resume. No history replay or session-id map.
- Acknowledged steering using acp-extension-core identity metadata.
- Native usage/context snapshots, automatic compaction activity and /compact.
- ACP-selected stdio MCP tools with text/image results and cancellation.
- Questionnaire: one or more questions in Lody's existing question card.
- Todo: list/add/toggle/clear through Lody's existing checklist.
- Subagent: native Lody task lifecycle, list, output and individual cancellation.

MCP audio, resource links and embedded resources are unsupported: a result containing
any of these fails explicitly, including mixed results. Structured JSON output is
appended as text. This validates returned content; it cannot undo an MCP tool's effects.

Questionnaire waits inside the parent tool call and returns answers or cancellation.
Late answers are ignored. Child agents do not ask questions; they report missing
information to the parent. Official TUI Question/Questionnaire code is not loaded.

Todo state is persisted in Pi tool results and reconstructed on resume. ACP
checklist updates are a display projection. There is no second todo database.
Todo completion maps to pending/completed; the tool does not invent in-progress
status. The /todos terminal window is not provided.

Subagent launches an isolated official Pi child and waits for exit. It inherits
the parent's model, thinking level and cwd and uses Pi's built-in tools.
It does not inherit MCP clients or load questionnaire/subagent/user extensions.
The execution owner generates task ids and supplies Core task metadata; Lody
presents the native task UI and forwards list/output/cancel requests.
Output queries retain the last 64 Ki characters for the current runtime.
Completed child processes are not resumed after adapter restart.
Child tasks are not detached background jobs or separate Lody sessions.

## Lifecycle

An ordinary prompt response from Pi acknowledges preflight. The adapter then
waits for native agent_settled, which covers the supported native model loop and
awaited tools, retries and automatic compaction. Manual compact instead waits for
its RPC result. Execution settlement is followed by output delivery and cleanup;
a new request cannot overtake this barrier.

Stop does not release admission immediately. It waits for preflight if necessary,
cancels outstanding questions, clears queues, aborts Pi, and waits for request
cleanup. A transport failure fails the request. Connection close terminates the
owned process group, including non-detached child agents.

On Windows, the adapter joins a Windows Job before starting Pi. Adapter exit
releases the Job and terminates remaining descendants, including MCP servers.
Unexpected Pi exit ends the connection with a nonzero adapter exit code; native
session files remain available for explicit resume through a new connection.
This adds no worker process. Missing or unusable native support fails startup.

Ordinary diagnostics do not replace the model's terminal outcome. Session file
changes cannot silently retarget ACP identity. No extension may enqueue work
after its tool returns or replace the parent session.

## Exclusions

V1 does not support arbitrary community or official-example plugin loading,
Plan Mode, presets/tool-selection plugins, extension-triggered compaction,
hot reload, handoff/session-navigation plugins, permission/environment plugins,
terminal UI adaptation, background child jobs or recursive subagent tools.

## Validation

Windows source development requires `pnpm build:native` with the Visual C++
toolchain and Python available. Published packages carry CI-built Node-API
modules for Windows x64 and ARM64; end users do not compile them. The Check
workflow assembles the distributable tarball only after both Windows jobs pass.

```sh
pnpm check
pnpm build
pnpm smoke
pnpm pack
```

Unit tests protect transport failure, session identity, steering, final outcomes,
cancellation and delivery ordering. The native smoke uses the official CLI and a
local synthetic model endpoint, not a test provider plugin. It checks question
answers/cancellation, todo recovery, subagent lifecycle/output/cancel and plugin
discovery exclusion. The same script accepts an installed dist/index.js path.

These checks do not establish current Electron visual acceptance or real-provider
quality. Historical checks of the previous SDK implementation do not validate
this architecture.
