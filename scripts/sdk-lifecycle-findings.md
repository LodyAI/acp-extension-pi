# SDK lifecycle feasibility, Pi 0.85.1

The message-action ownership approach fixes the reproduced early-completion case,
but the current candidate is **not a complete, transparent replacement for RPC**.
This is a feasibility result, not approval to migrate or merge PR #1.
Production source is unchanged from `ad680fea61feb57a446f122950942072cf3f5355`.

Run `node scripts/sdk-lifecycle-probe.mjs`. It runs 32 synthetic scenarios against
the installed, pinned SDK. A zero exit means the observations were reproduced;
some assertions deliberately establish failures of a candidate. It does **not**
mean the candidate passes ACP acceptance. No commercial provider is used.
The fixtures isolate extensions, skills, context files, settings and session files.
Explicit promises gate each asynchronous boundary; the watchdog only detects hangs.
Generated fixture directories are removed on exit.

## Observed matrix

| Path                                        | Gate / observation                                                    | Result                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Initial `session_start` sends input         | Before-agent-start promise remains blocked after binding returns      | Host must bind before emitting startup, then drain startup work                                                           |
| Settled callback sends follow-up            | Parent prompt resolves while child preflight is blocked               | Native promise ownership holds the child; removing the message binding loses it                                           |
| Nested follow-up commands                   | Command awaits native `waitForIdle`, then sends another input         | Three runs drain without self-deadlock; command idle must not wait on its own host operation                              |
| `sendMessage({triggerTurn:true})`           | Child context processing is blocked                                   | Message binding holds the native custom-message promise                                                                   |
| `nextTurn` custom context                   | Command finishes without a model call                                 | Context is consumed by the next input; no invented turn                                                                   |
| Extension manual compaction                 | Command returns while compaction callback is blocked                  | Message-only binding misses it; full context binding holds it                                                             |
| Automatic post-run compaction               | Native compaction callback is blocked                                 | Parent prompt owns completion and cancellation                                                                            |
| Stop during `input` / `before_agent_start`  | Abort returns before the gate opens                                   | Plain abort permits a subsequent agent run; promise ownership alone is insufficient                                       |
| Same Stop with public stream callback guard | Cancel before releasing preflight                                     | Zero provider calls after cancel, native aborted outcome, subsequent request succeeds; preflight itself still must return |
| Stop during model/tool work                 | Abort releases the native tool's signal; settled callback sends input | Closing admission for this cancelled operation prevents another run                                                       |
| Stop during manual compaction               | Error callback sends another input                                    | Without closed admission another run starts; with it none starts                                                          |
| Command failure                             | Command throws before a model run                                     | Native prompt resolves; command error must be read from the error event                                                   |
| Callback diagnostic                         | Settled callback throws after success                                 | Notice does not replace the terminal assistant outcome                                                                    |
| Provider failure and recovery               | Synthetic provider throws, then succeeds                              | Native prompt resolves with an error assistant message; next outcome is successful                                        |
| Question in command and tool                | Host UI promise stays open                                            | Operation remains held; host invalidates the question on cancel and rejects a later answer                                |
| Reload                                      | New startup input is blocked                                          | `beforeSessionStart` binds before startup; captured old Pi API rejects use                                                |
| Reload failure                              | Injected resource-loader service throws                               | Old API is invalid; ACP binding must also become unusable                                                                 |
| New / fork / switch                         | Replacement startup input is blocked                                  | Factory + rebind callback hold work and invalidate old API, including switch to the same file                             |
| Replacement failure                         | Injected factory fails after teardown                                 | Failure propagates and old API is invalid; host must clear its binding                                                    |
| Fresh replacement context                   | `ctx.sendUserMessage` preflight is blocked                            | It bypasses `ExtensionRuntime`; forwarding its public methods through the owner fixes the gap                             |
| Full `bindCore` context replacement         | Query command context's prompt options before/after binding           | Current minimal binding loses custom system-prompt options, though the model's assembled prompt is unchanged              |
| Dispose during preflight                    | Release preflight after `session.dispose()`                           | Provider is still called; dispose is not process shutdown                                                                 |
| Detached background action                  | Trigger action only after original operation drains                   | It is a later operation; a global pending set cannot establish its ACP request ancestry                                   |

These are SDK-level observations. Question tests exercise synthetic host UI binding,
not Core elicitation over an actual ACP transport. Replacement tests exercise Pi's
runtime factory with isolated synthetic services, not the production services setup.
The full binding is intentionally a candidate under test; it is not exported or
installed in the adapter.

## Public API boundary

The installed SDK's `docs/sdk.md` documents `extensionsResult.runtime`,
`AgentSessionRuntime`, and rebinding after replacement. The exported declarations
provide `ExtensionRunner.bindCore`, `AgentSession.reload({beforeSessionStart})`,
and the configurable `Agent.streamFunction` callback. The probe does not alter
Pi source, prototypes, private fields, or `AgentSession` methods.

This is evidence about **0.85.1**, not an upstream promise of stability across
versions. The declarations still describe initialization using an older method
name in some comments. Upgrade acceptance must run the behavioral probes, not
rely on the presence of exported types alone.

`ExtensionRuntime` contains the `pi.*` actions. It does not contain the `ctx.*`
actions. `bindCore` replaces the latter as a complete object and provides no
partial getter/decorator for the current context implementation. Calling it only
to obtain `compact` ownership requires supplying the other host context actions.
The probe demonstrates a concrete compatibility regression when those defaults
are not faithfully supplied: `getSystemPromptOptions()` loses `customPrompt`.
An old command context cannot forward this getter after rebinding: its getter
reads the same runner's current function and would recurse.

The SDK exposes native resource-loader data and tool definitions, so a host could
reconstruct these options. That would duplicate Pi's option-assembly behavior;
the current probe does not claim that reconstruction is transparent or necessary.
This is an unresolved design cost of the full-binding variant, not proof that
all SDK approaches are impossible.

## Architecture decision

There should be one operation owner between ACP and the native SDK. User prompts,
extension messages, manual compaction, and replacement-context messages register
their **native promises** with that owner. Calls started before the owner drains
join it; detached work that starts afterward needs its own admission and must not
retroactively extend a completed ACP response. Pi retains execution, tools, queues,
model state, session files and context calculation.

The owner closes admission for a cancelled operation before clearing queues,
resolving its questions, and aborting native work. It still drains accepted work.
The stream callback guard prevents a cancelled preflight from reaching the provider
once it returns. It cannot stop arbitrary plugin code or make an unresolved plugin
promise return. A bounded forced stop requires the owned worker process boundary;
silently returning `end_turn`, reusing the session while old work remains, or
treating `dispose()` as a kill is incorrect. Ordinary background actions must not
be globally disabled by a permanent `closed` flag: the probe's flag is scoped to
one experiment, not a production scheduling design.

Completion comes from draining accepted calls, then reporting native terminal
outcome, usage and output cleanup once. `agent_settled` becomes progress information.
Question validity follows the operation/UI lifetime, not one model's settled event.
Configuration and session replacement exclude other admitted operations. Successful
reload binds before startup. Shutdown, replacement and failed recreation invalidate
the old ACP binding even if the native file path remains equal.

The architecture is reviewable, but the candidate does not meet full acceptance:

1. A transparent `ctx.compact` binding must preserve the rest of native command
   context behavior. The current full-binding version demonstrably does not.
2. A real operation owner must distinguish cancelled ancestry from later legitimate
   background work. The probe's pending set proves promise retention, not that policy.
3. Worker shutdown and new SDK-to-ACP elicitation/output ordering need integration
   acceptance. This experiment proves why dispose cannot replace process shutdown;
   it does not implement or verify a new SDK worker.

These gaps rule out directly shipping the small message-binding PoC or an unverified
full SDK migration. They do not justify disabling user plugins, an allowlist, a Pi
fork, or modifying Lody/Core.

## Concrete replacement surface if these gaps are resolved

| Existing area                                                  | Replace / preserve                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/connection.ts` RPC calls and completion polling           | Replace with native SDK calls under one operation owner; remove settled/snapshot completion guards rather than running both paths           |
| `src/transport.ts` Pi JSONL protocol                           | Retire the Pi-specific RPC transport; do not retain it as a fallback executor                                                               |
| `src/server.ts` Pi RPC child                                   | Keep process isolation and process-tree shutdown, but host the SDK there; preserve ACP stdout isolation                                     |
| `src/extension.ts` RPC readiness and private command transport | Remove RPC-only plumbing once native bindings cover it; preserve native identity invalidation, tree refusal and steering metadata semantics |
| `src/mcp.ts`, Core contracts, output and usage projection      | Reuse with SDK host bindings; Pi remains the source for tools, stats and native history                                                     |
| Existing tests                                                 | Replace event/snapshot completion tests with operation-level behaviors; retain independent ACP/MCP/output/process tests                     |

No production migration, plugin modification, review request, or external comment
is part of this change. Existing green RPC tests are compatibility checks only;
they are not evidence that this SDK architecture is complete.
