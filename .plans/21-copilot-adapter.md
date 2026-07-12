# 21 — GitHub Copilot Provider Adapter

Add a native GitHub Copilot provider to t3code using `@github/copilot-sdk`, registered
alongside the five existing drivers (Codex, Claude, Cursor, Grok, OpenCode). Target is
feature parity with the existing adapters: streaming turns, dynamic model catalog, tool
lifecycle rendering, approvals, resume, interrupt, token usage, and error mapping.

## SDK facts (verified 2026-07-12)

- Package: `@github/copilot-sdk`, latest **`1.0.0-beta.9`** (still beta, not GA).
  Depends on `@github/copilot` (^1.0.55-5) — the CLI is bundled as a dependency and
  spawned over stdio by default (`RuntimeConnection.forStdio({ path?, args? })`), so a
  user-installed `copilot` binary can be pointed at via `path`, mirroring how other
  drivers respect `binaryPath`.
- Engines: Node >= 20 (repo runs Node ^24.13.1 — fine).
- Auth: `useLoggedInUser: true` by default (uses the CLI's logged-in GitHub user, i.e.
  `copilot` login / gh auth). Optional `gitHubToken` override. No token handling needed
  in the adapter beyond surfacing "not logged in" in the driver probe.
- Core API: `new CopilotClient({...})` → `client.createSession({ model, streaming,
  reasoningEffort, onPermissionRequest, onUserInputRequest, hooks, tools, systemMessage,
  infiniteSessions })` → `session.send({ prompt, attachments })` /
  `session.on(eventType, handler)` / `session.abort()` / `session.disconnect()`.
- Resume: `client.resumeSession(sessionId, { onPermissionRequest })`;
  `client.listSessions()` returns `SessionMetadata` incl. cwd/gitRoot/branch context.
- Session events: `user.message`, `assistant.message`, `assistant.message_delta`,
  `assistant.reasoning`, `assistant.reasoning_delta`, `tool.execution_start`,
  `tool.execution_complete`, `session.idle`, `session.compaction_start`,
  `session.compaction_complete`, plus client-level lifecycle events
  (`session.created|deleted|updated|foreground|background`).
- Permissions: `onPermissionRequest(request, invocation)` with
  `request.kind: "shell" | "write" | "read" | "mcp" | "custom-tool" | "url" | "memory"
  | "hook"` and fields `toolCallId`, `toolName`, `fileName`, `fullCommandText`.
  Decisions: `approve-once`, `approve-for-session`, `approve-for-location`,
  `approve-permanently`, `reject { feedback? }`, `user-not-available`, `no-result`.
- Models: `reasoningEffort: "low" | "medium" | "high" | "xhigh"`; model list via
  `listModels()` (check which models support effort). No documented model-catalog
  event; treat listing as a probe-time call.
- Interrupt: `session.abort()` aborts the in-flight message.
- Token usage: compaction events carry token counts; per-turn usage granularity needs
  a runtime spike (see Open Questions).

## Architecture recap (what we plug into)

A provider = three pieces created by a `ProviderDriver.create()`
(`apps/server/src/provider/ProviderDriver.ts`):

- `snapshot: ServerProviderShape` — status/models/version, built via
  `makeManagedServerProvider` with a `checkProvider` probe (see `ClaudeDriver.ts`).
- `adapter: ProviderAdapterShape<ProviderAdapterError>` — the runtime surface
  (`apps/server/src/provider/Services/ProviderAdapter.ts`): `startSession`, `sendTurn`,
  `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`,
  `listSessions`, `hasSession`, `readThread`, plus `capabilities.sessionModelSwitch`.
- `textGeneration` — used for thread titles etc.; Copilot can reuse a cheap model via
  the SDK, or delegate initially (see Phase 6).

Drivers are plain values registered in `apps/server/src/provider/builtInDrivers.ts`;
`ProviderDriverKind` is an **open branded slug** (`providerInstance.ts`) so
`ProviderDriverKind.make("copilot")` requires no contracts enum change. Settings do
require a contracts change: the legacy `ServerSettings.providers` struct
(`packages/contracts/src/settings.ts` ~L396) keys per-driver schemas.

Adapters emit `ProviderRuntimeEvent` (`packages/contracts/src/providerRuntime.ts`):
`session.* / thread.* / turn.* / item.* / content.delta / request.* / user-input.*`
with canonical item types (`assistant_message`, `reasoning`, `command_execution`,
`file_change`, `mcp_tool_call`, `dynamic_tool_call`, …) and request types
(`command_execution_approval`, `file_change_approval`, `file_read_approval`,
`tool_user_input`, …). `RuntimeEventRawSource` is a closed union — add a
`"copilot.sdk.event"` literal for the `raw.source` passthrough.

## New files

| File | Modeled on |
| --- | --- |
| `apps/server/src/provider/Drivers/CopilotDriver.ts` | `ClaudeDriver.ts` |
| `apps/server/src/provider/Layers/CopilotProvider.ts` | `ClaudeProvider.ts` (probe, models, pending/error snapshots) |
| `apps/server/src/provider/Layers/CopilotAdapter.ts` | `OpenCodeAdapter.ts` (structure) + `ClaudeAdapter.ts` (permission Deferred pattern) |
| `apps/server/src/provider/Layers/CopilotAdapter.test.ts` | `OpenCodeAdapter.test.ts` |

Touched files:

- `packages/contracts/src/settings.ts` — add `CopilotSettings`
  (`enabled`, `binaryPath` placeholder `copilot`, `customModels`; add `homePath` →
  maps to SDK `baseDirectory`/`COPILOT_HOME` for multi-account isolation) + wire into
  `ServerSettings.providers.copilot` and the settings-patch struct.
- `packages/contracts/src/providerRuntime.ts` — add `"copilot.sdk.event"` to
  `RuntimeEventRawSource`.
- `apps/server/src/provider/builtInDrivers.ts` — register `CopilotDriver`, extend
  `BuiltInDriversEnv`.
- `apps/server/package.json` — add `@github/copilot-sdk@1.0.0-beta.9` (pin; it's beta,
  expect churn).
- Web UI: nothing expected — instances/catalogs flow through existing contracts. Verify
  any driver-kind icon/accent map in `apps/web` has a fallback.

## Event translation map

| Copilot SDK event | ProviderRuntimeEvent |
| --- | --- |
| send accepted / turn begins | `turn.started` (model + effort from selection) |
| `assistant.message_delta` | `content.delta` (`streamKind: "assistant_text"`) + `item.started` (`assistant_message`) on first delta |
| `assistant.message` | `item.completed` (`assistant_message`, full content in `data`) |
| `assistant.reasoning_delta` | `content.delta` (`streamKind: "reasoning_text"`) |
| `assistant.reasoning` | `item.completed` (`reasoning`) |
| `tool.execution_start` | `item.started` — map tool name → `command_execution` (shell), `file_change` (edit/write), `mcp_tool_call`, else `dynamic_tool_call`; `status: "inProgress"` |
| `tool.execution_complete` | `item.completed` (`status: "completed" | "failed"`, result in `data`) |
| `session.idle` | `turn.completed` (`state: "completed"`) + `thread.state.changed` → `idle` |
| `session.abort()` acknowledged | `turn.completed` (`state: "interrupted"`) or `turn.aborted` |
| `session.compaction_start/complete` | `item.started/completed` (`context_compaction`) + `thread.token-usage.updated` from compaction token counts |
| permission request opened | `request.opened` (mapping below) |
| permission resolved | `request.resolved` |
| `ask_user` via `onUserInputRequest` | `user-input.requested` / `user-input.resolved` |
| SDK/process error | `runtime.error` (`class: "provider_error" | "transport_error"`) |

Every emitted event carries `raw: { source: "copilot.sdk.event", messageType, payload }`
so the NDJSON native event logger (`EventNdjsonLogger`) works like other adapters.

## Permission mapping (risk center)

Register a `onPermissionRequest` handler at `createSession`/`resumeSession` that
implements the ClaudeAdapter `canUseTool` pattern (ClaudeAdapter.ts ~L3250–3410):

1. Handler fires → create `Deferred<ProviderApprovalDecision>`, store in
   `pendingRequests: Map<RuntimeRequestId, PendingApproval>`.
2. Emit `request.opened` with `requestType` mapped from `request.kind`:
   `shell` → `command_execution_approval` (detail: `fullCommandText`);
   `write` → `file_change_approval` (detail: `fileName`);
   `read` → `file_read_approval`;
   `mcp` / `custom-tool` / `url` / `memory` / `hook` → `unknown` with `detail` =
   kind + toolName (revisit if UI needs richer rendering).
3. `respondToRequest(threadId, requestId, decision)` resolves the Deferred.
   Decision mapping: approve → `{ kind: "approve-once" }`; approve-for-session
   (if the UI decision variant exists for this driver) → `approve-for-session`;
   deny → `{ kind: "reject", feedback }`; session teardown/abort →
   `{ kind: "user-not-available" }` and `Deferred.succeed(…, "cancel")` like
   ClaudeAdapter does on interrupt.
4. Emit `request.resolved` after resolution.

## Sessions, resume, interrupt

- `startSession`: build one `CopilotClient` **per session** (matches per-instance
  isolation invariants in `ProviderDriver.ts`; revisit client-per-instance pooling as an
  optimization later). `createSession({ model, streaming: true, reasoningEffort,
  onPermissionRequest, onUserInputRequest })` with `workingDirectory` = thread cwd.
- Resume cursor: persist `{ copilotSessionId }` following the
  `readClaudeResumeState` / `updateResumeCursor` pattern (ClaudeAdapter.ts ~L562,
  ~L1447). On thread reopen: `client.resumeSession(id, { onPermissionRequest })`.
- `interruptTurn`: `session.abort()`, resolve all pending approval Deferreds to
  cancel, emit `turn.completed(state: "interrupted")`.
- `stopSession`: `session.disconnect()` + `client.stop()` (fall back to `forceStop()`
  on timeout), close the session `Scope` (OpenCodeAdapter's `sessionScope` pattern).
- `capabilities.sessionModelSwitch`: `"unsupported"` initially (model fixed at
  createSession; a switch = new session with resume — same approach can upgrade later).

## Model catalog

- Probe-time (`CopilotProvider.ts`): call SDK `listModels()` (spike exact client API —
  README documents `onListModels` and effort support "via listModels()"); merge with
  `customModels` from settings via `providerModelsFromSettings` like ClaudeProvider.
- Fallback static list if probe fails: `gpt-5`, `claude-sonnet-4.5` (README examples).
- Expose `reasoningEffort` as a model option descriptor (select: low/medium/high/xhigh)
  for models that report support — the same options mechanism OpenCode uses for
  agent/variant. This is the pattern the future Flue adapter will reuse for
  agents-as-options.

## Driver probe (CopilotDriver + CopilotProvider)

- Install detection: resolve `binaryPath` (default `copilot` on PATH); if absent, the
  SDK's bundled CLI still works — report snapshot as installed-via-sdk. Version via
  `copilot --version` equivalent.
- Auth detection: cheapest reliable probe is `client.start()` + `ping()` +
  a `listModels()`/session dry call; spike what the CLI offers for a non-interactive
  auth-status check before committing (Claude uses `probeClaudeCapabilities`).
- Maintenance: `makePackageManagedProviderMaintenanceResolver` with npm package
  `@github/copilot` (confirm homebrew formula exists; omit if not).
- Snapshot refresh: 5 min, mirroring `SNAPSHOT_REFRESH_INTERVAL` in ClaudeDriver.

## Phases

1. **Contracts + skeleton** — `CopilotSettings`, raw-source literal, empty
   provider/adapter/driver compiling, registered in `BUILT_IN_DRIVERS`, provider shows
   (non-functional) in the picker. Milestone: Effect Layer wiring typechecks
   (`vp check` + `vp run typecheck`).
2. **Driver probe** — install/version/auth detection, pending/error snapshots, static
   model catalog. Milestone: provider card shows real status.
3. **Happy path** — createSession, send, streaming deltas → `content.delta`, final
   message item, `turn.completed` on idle. Milestone: prompt in UI, streamed reply.
4. **Tool lifecycle + approvals** — event map above + permission Deferred plumbing.
   Milestone: shell command approval round-trips from the UI.
5. **Resume + interrupt + usage** — resume cursors, abort propagation, compaction/token
   events, `readThread` snapshot, error mapping to `ProviderAdapterError` variants.
6. **Polish** — dynamic model list with effort options, `textGeneration` (or delegate),
   `CopilotAdapter.test.ts` with mocked SDK client (OpenCodeAdapter.test.ts pattern),
   docs page under `docs/providers/`.

Definition of done per AGENTS.md: `vp check` and `vp run typecheck` pass; adapter tests
green via `vp run test`.

## Open questions / spikes

1. **Per-turn token usage** — does the SDK surface usage outside compaction events?
   If not, `thread.token-usage.updated` fires only on compaction (acceptable v1).
2. **`listModels()` exact call surface** — README references it but doesn't document a
   client method signature; confirm against `dist/index.d.ts` after install.
3. **Non-interactive auth probe** — best mechanism for "installed but not logged in"
   without spawning a full session.
4. **Turn boundaries** — confirm `session.idle` is the only end-of-turn signal, and how
   errors mid-turn surface (event vs. rejected promise from `send`).
5. **Beta churn** — pin the SDK version; the permission-kind list is documented as
   open-ended ("additional kinds may be added") so the mapping must default-case.
