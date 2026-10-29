# Pi command discovery

Status: implemented
Translation: current

[中文](2026-10-29-command-discovery.zh.md)

## Decision

[Issue #16](https://github.com/LodyAI/acp-extension-pi/issues/16): the adapter
could execute commands but never published their catalog. Shared activation
preparation now queries native `get_commands`, adds the adapter's `stats` and
`compact` with the same precedence as execution, and removes the private steering
command. Native descriptions are optional; command names must be nonempty strings.
Discovery errors fail activation rather than masquerading as an empty catalog.

The same array goes into the session response and an awaited standard ACP
`available_commands_update`. Both are necessary: Lody capability discovery reads
only the response, while ACP clients consume the notification. Load preserves the
response fields. There is no stored catalog, deferred resend, per-prompt discovery,
version branch, or extension-source blacklist. Existing Pi disposition and
cancellation ownership remain unchanged; arbitrary TUI/detached plugin support
is outside this change.

## Verification

`pnpm check` passes (118 tests, one Windows-only skip), as do `pnpm build` and
`pnpm smoke` in ordinary and codemode-only modes on macOS. Desktop UI and Windows
were not run locally.

The owning wire suite checks discovery, collisions, private-command exclusion,
activation refresh and explicit failures. Official-CLI smoke checks response and
notification agreement at activation, then executes an advertised extension
command that completes without a model run. Existing stats/compact smoke remains.
History assertions exclude command metadata while retaining their original
message and tool ordering coverage. No behavioral tests were deleted.

Publication of a rebuilt managed runtime is separate from this source change.
