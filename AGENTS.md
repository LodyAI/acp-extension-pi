# acp-extension-pi

Standalone public ACP adapter for Pi. Lody consumes its executable; do not import
Lody workspace packages or fork its session executor here.

- Pi owns tools, execution and native session files. Store the native file path as
  ACP session identity; never replay Lody history or add a session-id map.
- `package.json` pins the runtime. Keep `src/version.ts` aligned when upgrading and
  verify the upstream RPC lifecycle before changing the pin.
- The owned SDK worker replies only after the native prompt and all accepted
  extension calls finish. Native preflight ACK and `agent_settled` are not completion.
  Abort clears queues first and retains ownership through native cleanup.
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
  Native tree navigation is unsupported: cancel it before it changes the branch
  inside an otherwise unchanged session file.
- stdout is exclusively ACP. Diagnostics belong on stderr. Close the owned Pi
  process tree when the ACP transport closes; never silently retry a prompt.
- Explicitly visible custom messages and UI notifications use ACP output; hidden
  custom context and internal steering payloads must not become duplicate chat.
- Ordinary Pi extension errors are notices, not model failures. Preserve failed
  input commands when Pi reports them as handled without starting a model run;
  callback diagnostics must not overwrite the assistant's terminal outcome.
  Preserve final token-limit termination and accepted cancellation on every prompt path.
  Settle those outcomes in one place. Ordinary post-turn configuration refresh failure
  is diagnostic; native identity, transport and cleanup failures must not be hidden.
  Optional query fallbacks check the transport's own failure state, including
  session setup where there is no active prompt to reject on disconnection.
  Command ACK and model settlement do not finish extension-triggered compaction.
  `Operations` owns native call lifetimes; do not add a second event/state finisher.
  Events and state queries only report progress and configuration. A detached call
  after successful completion starts background work and holds subsequent admission.
  Cancelled ancestry cannot restart work; preflight and late-created compaction
  must inherit Stop before they can start provider work.
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
- Pi session stats own cumulative usage and context occupancy, including compaction.
  Refresh context snapshots at assistant-message boundaries and settlement; do not
  derive another context estimate from provider message usage or a cached model.
  Do not infer model
  attribution for summary/tool charges or turn unknown context occupancy into zero.
  Activity notifications describe Pi operations; they never own run completion.
- Tests use synthetic inputs and explicit signals; no sleeps or commercial models
  in CI. Never commit credentials, real transcripts or temporary validation data.

Implementation changes go through a Draft PR. Do not push implementation directly
to the default branch without an explicit request to bypass PR review.

Run `pnpm install`, `pnpm check`, `pnpm build`, and `pnpm smoke` before committing.
Keep the adaptation small and remove duplicate or implementation-only tests.
