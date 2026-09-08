# acp-extension-pi

Lody-owned ACP adapter for Pi's native RPC runtime. This repository continues the
working prototype in [Lody PR #464](https://github.com/LodyAI/Lody/pull/464), following
the maintainer's recommendation to maintain Pi alongside the builtin adapters.
[Lody Issue #451](https://github.com/LodyAI/Lody/issues/451) tracks product integration.

```text
Lody / ACP client -> ACP stdio -> acp-extension-pi -> Pi JSONL RPC
                                    |
                                    + bundled extension loaded inside Pi
```

The adapter uses the shared `acp-extension-core` contract and pinned
`@earendil-works/pi-coding-agent@0.85.1`. It does not depend on the Lody workspace.
Pi owns model execution, tools and native session files. ACP session ids are those
file paths; resume switches to the same file without replay or a second id map.
One ACP connection owns one Pi process and working directory. Session replacement
and configuration exclude concurrent prompts; a failed replacement invalidates the
old identity. Clients must create or resume a session before sending further input.

## Run from source

Requires Node.js 22.19+ and pnpm 10.20.0:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/index.js
```

Configure an ACP client to launch `node` with the absolute path to `dist/index.js`.
Arguments are forwarded to Pi, for example `--provider commandcode --model
deepseek/deepseek-v4-flash`. The adapter always adds RPC mode and its bundled
steering extension. Pi starts in the `session/new` or `session/resume` working
directory, not the ACP client's launch directory. stdout carries only ACP.

Pi reads its own credentials/settings on the execution machine. Authenticate with
Pi's terminal `/login`, or supply the provider's environment variables.
`PI_CODING_AGENT_DIR` selects an alternate profile. Credentials are not copied into
session metadata. Pi tools execute with Pi's native filesystem/process access;
extension questions are interactive input, not permission approval or sandboxing.

## Supported behavior

- Text, thinking, images, file links and embedded text; actual tool status/output.
- Dynamic model and thinking configuration, including startup values from Core's
  `_meta.lody.sessionConfig`; model selection precedes thinking configuration.
- Ordinary turns, cancellation, handled input commands, failures and native resume.
- Acknowledged steering through Core's request contract. A small in-process Pi
  extension queues a custom message with `details.steerId`. Only the matching
  `message_start` emits the Core applied notification. Repeated text is not identity.
  Idle/pre-start refusal lets the client keep input in its ordinary queue.
- `/stats`, `/compact [instructions]`, context usage and cumulative session usage
  notifications. Manual/automatic compaction and model retries use Core activity
  metadata; summary retry waits are distinct from the enclosing compaction result.
- Extension select/confirm/input/editor through ACP elicitation. Late answers cannot
  apply to a different turn; unsupported/out-of-turn questions are cancelled.

The ACP client must implement the Core steering contract and transfer history
ownership on the applied notification before consuming later output. Lody already
provides that barrier. The adapter sends notifications in native event order; ACP
notification delivery itself is not a remote acknowledgement of UI/history work.

Standard ACP **stdio MCP** servers are supported, including Lody's built-in server
and selected stdio workspace servers. The bundled Pi extension connects with the
MCP SDK and registers native tools; Pi owns their execution and cancellation. Tool
names are `mcp_<server>_<tool>`, with non-identifier characters replaced by `_`;
collisions and names exceeding 64 characters fail session setup. Discovery includes
all pages and takes a snapshot at session startup. HTTP/SSE, dynamic tool-list
updates, resource/prompt discovery, OAuth and MCP sampling/elicitation are not
implemented. Unsupported transports are rejected, not silently ignored.

Text/image results retain their content and MCP errors remain failed tool results.
Structured results are also provided as JSON text; other returned content blocks
are represented as JSON text rather than discarded. Cancellation requests do not
promise rollback of a server's side effects.

Each new/resumed session uses that ACP request's server configuration. The adapter
atomically stages it in a private temporary file under its existing configuration
exclusion; Pi reloads it with the extension. Setup fails unless the extension is
ready, including after partial server failure. This file is only a runtime handoff,
not session identity or durable settings, and normal shutdown removes it. Abrupt
process termination can leave a private temporary directory containing server env
values; these are never added to the native transcript or command line.

Pi's prompt ACK may describe an input command with no agent run. Started runs wait
for `agent_settled`, including retry/automatic compaction, rather than `agent_end`.
When a handled input or extension command finishes successfully without starting a
model run, the adapter emits a neutral Pi notice before returning `end_turn`.
Cancellation waits for `clear_queue`, `abort` and queued events before classifying
pending steer delivery. Natural settlement clears unapplied queued steer before
allowing another prompt. Unanswered extension questions are cancelled before abort.
Cancel returns after run cleanup; input or session replacement arriving during
cancellation/settlement waits for that cleanup, including the final usage snapshot.
EOF fails pending work. Closing the ACP connection lets Pi stop its tracked native
tool processes before the adapter waits for Pi to exit.

Permission modes, terminal-history import/discovery, session fork, TUI widgets,
in-app OAuth and managed artifact publication are not implemented. Existing
third-party `pi-acp` identities are not automatically migrated.
Simultaneous terminal editing of an active native session file is not coordinated.

Usage snapshots come from Pi `get_session_stats`, including native history and
summary/tool charges. They refresh on new/resume, configuration changes, `/stats`,
manual compaction (including failure/cancel), and agent settlement. They are
cumulative snapshots, not deltas. Pi does not attach model provenance to all these
charges, so the adapter sends an explicit empty `modelUsage` breakdown rather than
letting the host assign the whole session to the current model. Per-model billing
is not implemented.

After compaction, Pi reports context occupancy as unknown until a later model
response. The adapter does not invent a zero or reuse pre-compaction usage as a
new measurement. Current Lody accepts only numeric occupancy updates, however, so
its UI retains the previous percentage during this interval. That Host limitation
is a later display improvement, not a V1 requirement to invent an exact count.
The current custom-command setup verifies wire snapshots and `/stats`. Full cost
display must be accepted after Pi's planned managed builtin registration through
Lody's existing reporting path. Generic custom-agent accounting is outside this
PR; no change to the Host's builtin admission policy is proposed. Release and
integration acceptance remain tracked in [Lody #451](https://github.com/LodyAI/Lody/issues/451).

## Verification

```sh
pnpm check
pnpm build
pnpm smoke
```

CI also packs the adapter, installs the tarball into an isolated directory with
production dependencies, and runs the same smoke against its installed entry:

```sh
node scripts/smoke.mjs /absolute/install/node_modules/acp-extension-pi/dist/index.js
```

Unit tests cover framing/correlation, lifecycle settlement, retry, cancellation,
EOF, repeated steering identities and output order, native resume, model configuration,
usage and interactive input. The executable smoke uses a real pinned Pi runtime
with a synthetic offline provider: text/image/file-context delivery to the model,
rejected binary input followed by a successful turn, actual file write, input commands, questions,
stats, stdio MCP text/image/structured/error results, cancellation, changed server
configuration on resume/replacement, failed MCP setup, empty-selection removal,
MCP process/configuration cleanup, adapter signal shutdown with a real bash process, process
restart/native resume, and failed session replacement with explicit recovery.
It requires no provider credentials or network calls after dependency installation.
Temporary synthetic artifacts are retained at the printed path.

A live check of adapter implementation `3828569` through Lody's existing ACP client
passed CommandCode / DeepSeek V4 Flash file writes, acknowledged steering and the
host ownership lease, compaction, stats and process restart/native resume. It used
an isolated Pi profile with a smaller recent-context retention threshold for
compaction. A separate real-model ACP check passed MCP failed-result presentation,
continuation after failure, cancellation delivered to the MCP server, and a new
file-writing turn after cancellation. Credentials and normal Pi settings were
unchanged; real transcripts are not committed.

Windows process-tree shutdown/packaging and other providers remain unverified. The
original spike's full Electron validation is historical evidence.
No Core opt-out extension or Host MCP changes are required. Builtin registration
and managed artifact/release integration remain open. No npm or managed runtime
release is claimed by this initial source push.

A source-built local Electron check passed a selected workspace stdio tool through
the complete Desktop/CLI/ACP/Pi path. Its builtin authentication-address error came
from using the no-cloud source composition and is not a Pi integration prerequisite.

On 2026-09-08, the signed-in Lody 0.92.1 desktop passed a separate live check using
the current adapter as a custom command and CommandCode / DeepSeek V4 Flash:

- Native file writes and builtin `lody_session_list` returning the actual current
  session after resolving the real project id through `lody_session_create_options`.
- Steering during a gated bash tool changed the actual file outcome: the new file
  existed and the superseded file was never written.
- Stopping a gated tool terminated its process; the following turn wrote a file,
  surfaced a missing-file error and settled normally.
- After terminating the idle adapter and refreshing the desktop, Lody resumed the
  same native session file; the model recalled the prior result without tools.

The restart check also exposed a Host warning: configuration application against
the closed connection was described as a rejected thinking setting. The subsequent
restore successfully reapplied that setting and completed the turn. This warning
is recorded separately from adapter recovery. No Lody/Core patches were loaded for
this desktop check. This is scoped acceptance, not a claim that every builtin tool,
provider, desktop workflow or platform has been tested.

## Upstream contract and provenance

RPC behavior was checked against Pi 0.85.1's
[`rpc-mode.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/rpc/rpc-mode.ts),
[`agent-session.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts), and
[`RPC documentation`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md).

The translation, extension and protocol tests are adapted from Lody's Apache-2.0
[spike commit](https://github.com/Astro-Han/Lody/commit/4d78cc720c08bc35b5cac0971ae2db01e2fc86b5).
This version moves the translation behind ACP stdio, adds standalone runtime
ownership/build/testing and removes Lody-private imports. The direct connection
branch in PR #464 is preserved as spike evidence, not the production integration.
