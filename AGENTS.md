# acp-extension-pi

Standalone public ACP adapter for Pi. Lody consumes its executable; do not import
Lody workspace packages or fork its session executor here.

- Pi owns tools, execution and native session files. Store the native file path as
  ACP session identity; never replay Lody history or add a session-id map.
- `package.json` pins the runtime. Keep `src/version.ts` aligned when upgrading and
  verify the upstream RPC lifecycle before changing the pin.
- Prompt ACK means accepted or handled, not completed. Started runs finish only at
  `agent_settled`; input commands may finish without a run. Abort clears queues first.
  Cancel and admission after cancellation/settlement wait for the same run cleanup,
  including usage reporting and any abort still in flight.
- Steering is applied only on the matching custom-message metadata, never by text.
  Send the Core applied notification before later session updates. The ACP client
  owns its output/application barrier. Preserve provable idle refusal for requeue.
- Session replacement and model/configuration changes exclude concurrent prompts
  and other configuration operations. Clear native identity before replacement and
  on replacement failure; never allow an old or empty id to address the new file.
  Pi extension-driven new/fork/switch must invalidate the ACP binding, never silently
  follow the new file. Reload readiness belongs to the loaded extension runtime;
  shutdown invalidates it even when the native file stays the same.
- stdout is exclusively ACP. Diagnostics belong on stderr. Close the owned Pi
  process tree when the ACP transport closes; never silently retry a prompt.
- Ordinary Pi extension errors are notices, not model failures. Preserve failed
  input commands when Pi reports them as handled without starting a model run;
  callback diagnostics must not overwrite the assistant's terminal outcome.
  Preserve final token-limit termination and accepted cancellation on every prompt path.
- MCP uses standard ACP stdio configuration; reject unsupported transports before
  starting Pi. Pi's extension owns MCP clients/tools and native cancellation.
  Write runtime configuration only under the existing session/config exclusion;
  new/resumed sessions must observe fresh extension readiness before accepting input.
  Keep configuration secrets in private temporary files, never native history.
  Check MCP names against Pi's effective tool owners, including dynamic registration.
  Internal steer commands use a fresh invocation name per loaded extension runtime.
- Advertise only implemented capabilities. Permission modes, native history import
  and TUI replacement are not implemented.
- Use shared `acp-extension-core` contracts, not copied protocol definitions.
- Pi session stats own cumulative usage, including compaction. Do not infer model
  attribution for summary/tool charges or turn unknown context occupancy into zero.
  Activity notifications describe Pi operations; they never own run completion.
- Tests use synthetic inputs and explicit signals; no sleeps or commercial models
  in CI. Never commit credentials, real transcripts or temporary validation data.

Implementation changes go through a Draft PR. Do not push implementation directly
to the default branch without an explicit request to bypass PR review.

Run `pnpm install`, `pnpm check`, `pnpm build`, and `pnpm smoke` before committing.
Keep the adaptation small and remove duplicate or implementation-only tests.
