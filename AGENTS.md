# acp-extension-pi

Standalone public ACP adapter for Pi. Lody consumes its executable; do not import
Lody workspace packages or fork its session executor here.

- Pi owns tools, execution and native session files. Store the native file path as
  ACP session identity; never replay Lody history or add a session-id map.
- `package.json` pins the runtime. Keep `src/version.ts` aligned when upgrading and
  verify the upstream RPC lifecycle before changing the pin.
- Prompt ACK means accepted or handled, not completed. Started runs finish only at
  `agent_settled`; input commands may finish without a run. Abort clears queues first.
- Steering is applied only on the matching custom-message metadata, never by text.
  Send the Core applied notification before later session updates. The ACP client
  owns its output/application barrier. Preserve provable idle refusal for requeue.
- stdout is exclusively ACP. Diagnostics belong on stderr. Close the owned Pi
  process tree when the ACP transport closes; never silently retry a prompt.
- Advertise only implemented capabilities. MCP, permission modes, native history
  import and TUI replacement are not implemented. Reject MCP before starting Pi.
- Use shared `acp-extension-core` contracts, not copied protocol definitions.
- Tests use synthetic inputs and explicit signals; no sleeps or commercial models
  in CI. Never commit credentials, real transcripts or temporary validation data.

Run `pnpm install`, `pnpm check`, `pnpm build`, and `pnpm smoke` before committing.
Keep the adaptation small and remove duplicate or implementation-only tests.
