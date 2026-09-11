# Pi 0.85.1 SDK lifecycle acceptance

The initial probe showed why a direct `session.prompt()` replacement was
insufficient: extension APIs discard some native promises, callbacks can launch
work after model settlement, and rebinding extension contexts drops structured
prompt metadata unless the host supplies it. The adapter now owns those accepted
native calls through `Operations`; it does not reproduce Pi's executor or queues.

## Implementation boundary

- `worker.ts` composes the public SDK and reuses native `runRpcMode` for JSONL,
  extension UI and process cleanup. Its lazy startup lets Pi guard stdout before
  loading user extensions. User/global/project extension loading remains enabled
  subject to Pi's headless project trust policy and explicit resource flags.
- `native-host.ts` binds native actions through one operation owner. A facade
  retains accepted callback promises and delays the transport response until they
  drain. Fresh replacement contexts and reload use the same owner. Native stale
  contexts remain invalid. No AgentSession prototype/private method is patched.
- The public provider stream callback refuses cancelled preflight. Native
  `compaction_start` cancels a controller created after Stop; this event never
  completes the operation. Native prompt promises own retries and auto-compaction.
- Structured prompt options are projected from public native resources and active
  tool definitions. Pi still builds the actual prompt. Equality tests check native
  values before/after dynamic registration and reload, including normalized tool
  snippets and guidelines. This projection must be rechecked on a Pi upgrade.
- Detached calls after a successful operation start background ownership; output
  notifications expose that lifetime to ACP. Later input waits for it. Calls
  carrying cancelled ancestry are refused, even after their original owner exits.
- `connection.ts` translates output and performs final usage/question/steer cleanup.
  State snapshots and model settlement no longer decide request completion.

## Reproducible checks

Run `pnpm build && pnpm smoke` for the current implementation:

1. `sdk-host-smoke.mjs`: real SDK metadata, dynamic tools, reload, detached work,
   cancelled ancestry, new/fork/same-file switch/failure, fresh and stale contexts,
   custom continuation, native auto-compaction success/Stop, and a manual
   compaction controller created after Stop.
2. `sdk-worker-smoke.mjs`: real worker/JSONL; an explicitly gated callback preflight
   holds both prompt and Stop responses. After release, cancelled provider work
   never starts. Recovery and process shutdown are checked on that same worker.
   Auto-discovered global/project extensions verify trust refusal/acceptance and
   startup console diagnostics without corrupting the native JSONL stream.
3. `smoke.mjs`: full ACP process with synthetic native provider/MCP/tools, including
   settled-callback and detached-background questions, answer/Stop with queued
   input, session replacement, reload, compaction, steering and process cleanup.
   It also accepts an installed tarball's executable path for packaging acceptance.

`PI_QUESTION_EXTENSION=/absolute/path/question.ts pnpm smoke` exercises a separately
installed standard Pi question tool. It passed locally with the SDK worker on
2026-09-11. No user plugin changes or commercial provider calls were needed.

The original standalone probe was removed because it implemented a separate
experimental owner. Current regression tests exercise the production owner and
real worker instead. The former fake early-ACK cancellation test now checks the
actual ACP state-lookup boundary; worker tests protect native preflight cancellation.

Five source ablations each failed the corresponding production smoke: removing
message-call ownership, the provider cancellation gate, prompt metadata binding,
cancelled-ancestry rejection, or late compaction cancellation. Each mechanism was
restored before final verification. The simpler event/state completion loop was
removed permanently because the native-call owner replaces its responsibility.

## Limits

This verifies the pinned SDK on the current development machine, plus synthetic
ACP integration. Earlier real-model/Electron checks in the README predate this
migration and do not prove this revision's desktop acceptance. Windows, additional
providers, managed publication and builtin registration still require their own
acceptance. Arbitrary plugins must cooperate with cancellation to finish gracefully;
closing the connection terminates the owned worker/process tree. No timeout can
truthfully declare unreturned plugin work complete.
