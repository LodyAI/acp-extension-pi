# Deferred MCP through Pi's MCP extension

Status: implemented
Translation: current

[中文](2026-11-06-deferred-mcp-tool-search.zh.md)

## Decision

The adapter's own MCP bridge connected every selected server before the session
started and declared every tool to the model. One failing server failed the whole
activation with "Required Lody Pi extension did not initialize"
([issue #30](https://github.com/LodyAI/acp-extension-pi/issues/30)).

The packaged extension now runs Pi 1.4's `createMcpExtension` and
`createToolSearchExtension` and registers each ACP-selected server with
`pi.registerMcpServer(name, { ..., exposure: "deferred" })`. The model sees
`tool_search` and Pi's `mcp_servers` prompt section; matching
`mcp__<server>__<tool>` tools are declared after a search. This matches Lody's
Codex, whose MCP tools are also deferred behind tool search. Pi owns connection,
background startup, naming, result conversion, truncation, timeouts, `/mcp`, and
the transcript record that keeps loaded tools across resume and fork.

Boundaries kept:

- `loadConfig` returns no servers, so global and project `mcp.json` are ignored and
  a session sees only the Lody selection. `--no-extensions` stays.
- ACP env and header values are final. Pi would expand `$NAME`/`${NAME}` and run a
  leading `!`, so the adapter escapes `$` as `$$` and a leading `!` as `$!`.
- Lody display names are mapped to Pi's `[A-Za-z0-9_-]`. Names that collide (with
  `-`/`_` treated as equal) take a six-character hash of the server's name and
  target, so a resumed transcript's `mcp__<server>__*` tools keep their server when
  the selection order changes, as Codex does. Only an exact duplicate falls back to
  a numeric suffix. Invalid registrations become Pi config errors reported once.
- A client `override` system prompt (ACP `systemPrompt`) replaces Pi's prompt, which
  would drop the `mcp_servers` section. The workspace hook re-appends it after the
  client text, as Claude Code and Codex keep deferred-tool context outside the
  replaceable instructions.
- `openUrl` is a no-op (RPC mode has no browser) and the server log lives in the
  activation's private temporary directory.
- Stdio servers inherit the Pi process environment, as native Pi does. The SDK
  allowlist did not protect anything: Pi's bash tool and the user's local servers
  already run with the same authority.

Notices that Pi emits while a replacement runtime starts (before the new ACP id is
known) are buffered and published when the activation is prepared.

Replaced: the hand-written SDK bridge, its loadout reactivation hook and their
unit tests. `@modelcontextprotocol/sdk` remains only for the smoke fixture server.

Not in scope: mid-session MCP changes (they apply on the next new/resume/load/fork),
interactive OAuth sign-in, codemode as the default exposure, and MCP in subagents.

## Verification

`pnpm check` passes (136 tests, one Windows-only skip); `pnpm build` and
`pnpm smoke` pass in ordinary and codemode-only modes on macOS.

Unit tests run Pi's own resolver and validator against the escaped values and
registrations, check name normalization, and check that an invalid server is one
notice without leaking header values. A wire test checks that startup notices of a
replacement runtime reach the new activation; it fails without the buffer.

The MCP smoke phase uses the official CLI with ambient global and project
`mcp.json` present and an unstartable server next to the fixture. It asserts that
only `tool_search` is declared first, the `mcp_servers` section names the fixture,
a search loads `mcp__fixture__echo` for the next call, the ambient server never
appears, the failing server only produces a notice, `/mcp` reports
`fixture: connected, 4 tools (deferred)`, and the loaded tool is declared after
resume. Existing MCP image/error assertions use the new names; resource links now
reach the model as text, and an env value with `!`, `$HOME`, `${PATH}`, `$$` and
`$!` arrives verbatim. Under a client `override` prompt the system prompt starts
with the client text and still carries the `mcp_servers` section. Changing the
exposure to `direct`, or dropping the re-appended section, fails the smoke.

Lody desktop with a Custom ACP provider was not run for this note.
