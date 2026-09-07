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
- `/stats`, `/compact`, context usage and cumulative session usage notifications.
- Extension select/confirm/input/editor through ACP elicitation. Late answers cannot
  apply to a different turn; unsupported/out-of-turn questions are cancelled.

The ACP client must implement the Core steering contract and transfer history
ownership on the applied notification before consuming later output. Lody already
provides that barrier. The adapter sends notifications in native event order; ACP
notification delivery itself is not a remote acknowledgement of UI/history work.

Pi's prompt ACK may describe an input command with no agent run. Started runs wait
for `agent_settled`, including retry/automatic compaction, rather than `agent_end`.
Cancellation sends `clear_queue` before `abort`. EOF fails pending work, and closing
the ACP connection terminates the owned Pi process tree.

MCP, permission modes, terminal-history import/discovery, session fork, TUI widgets,
in-app OAuth and managed artifact publication are not implemented. MCP is refused
explicitly. Existing third-party `pi-acp` identities are not automatically migrated.
Simultaneous terminal editing of an active native session file is not coordinated.

## Verification

```sh
pnpm check
pnpm build
pnpm smoke
```

Unit tests cover framing/correlation, lifecycle settlement, retry, cancellation,
EOF, repeated steering identities and output order, native resume, model configuration,
usage and interactive input. The executable smoke uses a real pinned Pi runtime
with a synthetic offline provider: actual file write, input commands, questions,
stats, tool cancellation, ACP stdin shutdown during a running tool, process restart/
native resume, and failed session replacement with explicit recovery.
It requires no provider credentials or network calls after dependency installation.
Temporary synthetic artifacts are retained at the printed path.

A separate local live check through Lody's existing ACP client passed CommandCode /
DeepSeek V4 Flash file writes, acknowledged steering and the host ownership lease,
compaction, stats and process restart/native resume. It used an isolated Pi profile
with a smaller recent-context retention threshold for compaction. Credentials and
normal Pi settings were unchanged; real transcripts are not committed.

Windows process-tree shutdown/packaging and other providers remain unverified.
The original spike's full Electron validation is historical evidence; this repository
still needs Lody's builtin registration and managed artifact/release integration.
No npm or managed runtime release is claimed by this initial source push.

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
