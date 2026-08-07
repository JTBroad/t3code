# Sidebar apps: extracting Memory into a toggleable app

Status: implemented on `feat/sidebar-apps`, one commit per step. The plan below
is the design as proposed; this section records where the implementation
deliberately diverged from it.

## As built: deviations worth knowing

- **`AppHost` has no `appendThreadActivity`.** Seam 2 listed one, but seam 4's
  design — the reactor appends activities from a hook's return value — means
  nothing needs it. Adding it would also have made `AppHost` depend on the
  orchestration engine, which depends on the reactor, which depends on the
  registry: a layer cycle bought for an unused method.
- **MCP toolkit registration stayed in `McpHttpServer`.** The registry decides
  _whether_ an app's tools mount; it does not hold the layer. A toolkit's
  registration layer carries its own handler requirements, and a heterogeneous
  list of those cannot be expressed in one array without naming every app's
  dependencies in the registry type. The `enabledApps` gate is read in both
  places, so the toggle still governs tools.
- **Disabling an app is enforced twice.** Registration is gated at boot so a
  disabled app advertises no tools, and the handlers re-check per call so the
  toggle also applies to MCP sessions that are already open.
- **The settings UI still writes the deprecated core fields.** The app's own
  `settings.json` takes precedence and the core values are honoured as a
  fallback, so behaviour is correct either way. Moving the UI onto app-owned RPC
  is the remaining piece of seam 7.
- **Several memory helpers carry explicit `Effect` signatures.** Inference
  collapses to `unknown` on both channels once these compose, and an `unknown`
  requirement disqualifies every caller with an error that names no real service.
- **`MemoryLegacyImport` was added, unplanned.** Step 5 assumed the store was
  fully derivable. It is not, for one case: artifacts written before sidecars
  existed carry provenance only in the old table, and a plain reindex would drop
  it. The import writes those sidecars once before the first reindex.

## Why now

The Zettelkasten memory system currently ships as a feature welded into the core
app: tables in the shared database, methods on the core RPC contract, handlers in
`ws.ts`, a hook inside the turn lifecycle, and a hardcoded second entry in the
workspace rail. It works, but it is the wrong shape for what we actually want,
which is several of these: scheduled prompts, user-authored artifact apps, and
whatever the next one is.

The rail is the forcing function. The moment there is a second workspace button
there is an implicit contract for what a workspace _is_, and right now that
contract is a two-member union type. Better to name it while there is exactly one
consumer to migrate.

There is also a concrete maintenance cost already being paid. We run a fork and
merge upstream regularly. Memory's schema lives in `Migrations/039_MemoryAndDrive.ts`,
inside the same numbered sequence upstream keeps appending to. `f40c7012c`
("repair databases that skipped upstream's pinned migration") is what that
collision looks like when it goes wrong. Every fork-local table in the shared
migration sequence is a future merge conflict with a data-loss tail.

## What Memory touches today

The full coupling surface, so the extraction is scoped honestly:

| Seam              | Location                                                                                                                           | Notes                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Schema            | `apps/server/src/persistence/Migrations/039_MemoryAndDrive.ts`                                                                     | 4 tables in `state.sqlite`, deliberately not `projection_*`                                                                     |
| Wire contract     | `packages/contracts/src/memory.ts`, 6 entries in `WS_METHODS` + the RPC group in `rpc.ts`                                          | `memory.consolidate`, `readDaily`, `listNotes`, `getNote`, `listArtifacts`, `getArtifact`                                       |
| RPC handlers      | `apps/server/src/ws.ts` (~1429–1452)                                                                                               | plus `memoryPaths` in the server status payload (~1045)                                                                         |
| Config / settings | `config.ts` (`memoryDir`, `driveDir`), `contracts/settings.ts` (`memoryRootDirectory`, `driveRootDirectory`), `SettingsPanels.tsx` |                                                                                                                                 |
| Turn lifecycle    | `orchestration/Layers/ProviderCommandReactor.ts` (~1173)                                                                           | `buildBriefForThreadOrEmpty` + `prependBrief` on the first user message, emitting a `memory.continuity-brief.injected` activity |
| Agent tools       | `mcp/toolkits/memory/`, registered in `McpHttpServer.ts`                                                                           |                                                                                                                                 |
| Client            | `WorkspaceRail.tsx` / `.logic.ts`, `routes/memory.tsx`, branch in `__root.tsx`                                                     | rail entry key is the literal union `"threads" \| "memory"`                                                                     |
| Cross-store read  | `memory/ProjectResolution.ts`                                                                                                      | the **only** query joining core tables: `projection_threads ⋈ projection_projects` to map `threadId → workspace_root`           |

That last row is the good news. Nothing outside `apps/server/src/memory/` reads a
memory table, and memory reads exactly one thing out of core: which repository a
thread belongs to. A separate data store costs us one join, and that join is
better expressed as a host call anyway.

## Recommended approach

Extract a **host/app contract** with seven extension points, and make Memory the
first app that implements it. Do not build a plugin _runtime_ — no sandboxing, no
dynamic loading, no manifest resolution. Apps stay compiled into the server and
the client bundle for now. What we are buying is a seam, not isolation.

The distinction matters because it caps the work. A seam is types plus a registry
plus one migration. A runtime is a security boundary, a versioning policy, and a
distribution story, and we need none of that to ship scheduled prompts.

### 1. Own data store per app

Give each app `<stateDir>/apps/<appId>/state.sqlite` with its own migration
sequence starting at `001`, run by the same runner core uses (`makeSqlitePersistenceLive`
already takes a `filename`, so this is a second layer instance, not new
machinery). Memory's tables move there; `039_MemoryAndDrive.ts` becomes a
no-op tombstone that stays in the core sequence forever so already-migrated
databases keep their number. No row copy-forward is needed: the vault work in
step 4 makes every table rebuildable from disk, so the new store is populated by
reindex.

This is the highest-value single change. It ends the upstream migration
collision class permanently, it makes "uninstall this app" a directory delete,
and it means a broken app cannot corrupt thread state.

The cost is real but small: no cross-app joins, no single-transaction writes
spanning core and app state. Memory needs neither — it already treats its rows
as a rebuildable index over authoritative markdown, so a torn write is repaired
by the consolidation reindex pass rather than by a transaction.

### 2. A narrow host API instead of imports

Apps get an injected `AppHost` service rather than importing from
`apps/server/src`. Start with only what Memory actually needs:

- `resolveProjectForThread(threadId)` — replaces `ProjectResolution.ts`'s direct
  join, and is the one piece of core state apps legitimately need
- `appendThreadActivity(threadId, activity)` — how an app makes itself visible in
  the timeline
- `paths` — the app's own store root and data directory

Keep this list short and grow it on demand. Every method added is a compatibility
obligation — and once user apps exist, the postMessage form of this API is frozen
against files on users' disks. So the API carries a version from day one, and a
user-app manifest declares the version it targets. That is the whole versioning
policy for now; the point is that the field exists before anything depends on it.

### 3. Namespaced RPC, registered not hardcoded

Each app contributes an RPC group under an `app.<appId>.*` method prefix, merged
into the server's group at startup by iterating the app registry, instead of six
literal entries in `ws.ts`. `WS_METHODS` keeps working for core.

Recommendation: keep app RPC **statically typed per app** (each app exports its
own `Rpc.make` group from a package the client also imports) rather than
inventing a generic `app.invoke(appId, payload)` envelope. The envelope looks
more plugin-like and is worse: it throws away schema validation at the boundary
and pushes decoding into every app. Memory's existing contract shape is already
right — it just needs to live next to the app rather than in core contracts.

Memory's current `memory.*` methods should be kept as deprecated aliases for one
release rather than renamed in place, since mobile clients update on their own
schedule.

### 4. Turn-lifecycle hooks, not reactor edits

`ProviderCommandReactor` is the one place an app reaches into the harness, and it
is the place we must get right — the next three apps will all want it (scheduled
prompts especially). Replace the direct `buildBriefForThreadOrEmpty` call with a
declared hook the registry collects:

- `beforeFirstUserMessage(ctx) → { prependText? }` — what Memory's continuity
  brief uses
- later, as needed: `afterTurn(ctx)`, `onThreadCreated(ctx)`

Preserve the existing invariant explicitly in the hook contract: **nothing an app
injects into a prompt is invisible in the timeline.** Today that is enforced by
`ProviderCommandReactor` emitting the activity next to the injection. Under hooks,
the reactor should emit the activity on the app's behalf from the hook's return
value, so an app cannot forget to. Hooks must also be fail-open and time-bounded —
a hung app must not wedge a turn.

### 5. Rail entries and routes from a registry

`WorkspaceRail` reads the enabled-app list instead of a literal array; each app
declares `{ id, label, icon, rootPath }` and mounts a route subtree under
`/apps/<appId>`. `__root.tsx`'s `isMemoryWorkspacePath` branch generalizes to
"does the current path belong to an app workspace", which is the same predicate
with a lookup in it. `WorkspaceRail.logic.ts`'s remembered-return-path behavior
stays as-is — it is already app-agnostic in everything but the name.

Toggling is a settings-level enabled set (`enabledApps: string[]`). A disabled app
contributes no rail entry, no route, no RPC, no hooks, and no MCP tools — but its
store stays on disk, because "hide it" and "delete my notes" must not be the same
button.

### 6. MCP toolkits from the registry too

`mcp/toolkits/memory/` is a sixth registration surface and follows the same rule
as RPC: an app declares its toolkit, the registry merges it into the
`McpHttpServer` layer, and disabling the app removes the tools from every agent
session. Schedule will want tools as much as Memory does, so this goes in the
registry contract from the start rather than staying a hardcoded layer merge.

### 7. Where app settings live

`memoryRootDirectory` and `driveRootDirectory` sit in the shared
`contracts/settings.ts` schema today — the same fork-versus-upstream collision
class as migration 039, only for settings instead of tables. When the store
moves (step 5), app-specific settings move with it: each app keeps its own
`settings.json` under its app directory, surfaced through the same settings UI
via the registry. The one field that must stay in the core schema is
`enabledApps` itself — it is the bootstrap that decides which apps load, so it
cannot live inside an app. Keep it to exactly that one field.

## Sequencing

Each step is independently shippable and leaves the tree working.

1. **Host API + `ProjectResolution` swap.** No behavior change, no schema change.
   Proves the seam against the only real cross-boundary read.
   _Done when:_ existing memory tests pass unchanged and no file under
   `apps/server/src/memory/` imports from outside `memory/` except the `AppHost`
   service and contracts.
2. **App registry + rail/route generalization.** Memory becomes registry entry
   #1 while still using core RPC and core DB. The registry also takes over MCP
   toolkit registration (seam 6) — a mechanical move of the existing layer merge.
   Otherwise purely client-side plus a registry module; the riskiest-looking step
   is actually the cheapest.
   _Done when:_ toggling `enabledApps` adds/removes Memory's rail entry, routes,
   and MCP tools with no restart artifacts, and disabling it leaves the store on
   disk untouched.
3. **Turn hooks.** Move brief injection behind `beforeFirstUserMessage`. This is
   the step that needs the most test attention — `ProviderCommandReactor` is
   load-bearing for every turn, and its existing tests are the safety net.
   _Done when:_ reactor tests pass unchanged, the injected brief and its
   `memory.continuity-brief.injected` activity are byte-identical to before, and
   a hook that throws or hangs past its timeout provably lets the turn proceed
   without it.
4. **Vault work: drive sidecars + all three Obsidian gaps.** Four deliverables,
   one code path — reindex is what changes in every case:
   - drive sidecar `.meta.json` files, and a drive reindex that walks the folder
   - FTS5 virtual table over note title and body, populated by reindex
   - debounced mtime watcher, behind the same `reindexAll` / `reindexPath` pair as
     startup and manual triggers
   - `[[Title]]` link resolution via a title→id index, with unresolved links
     tolerated as a normal state

   This step is the one with standalone user-visible value: search and live
   hand-edit pickup are what make the vault feel like Obsidian rather than a
   database with markdown in it. It is also what turns step 5 from a migration
   into a reindex, so it stays ahead of the extraction.
   _Done when:_ deleting `state.sqlite` and reindexing reproduces every
   memory/drive row (the derivability claim, exercised as a test), body search
   returns notes tag search cannot, and a hand-edit lands in the index without a
   consolidation run.

5. **Store extraction.** New per-app SQLite file, `001` sequence, 039 tombstoned.
   With step 4 done there is nothing to copy forward — point at the new file and
   rebuild from the vault. App settings (`memoryRootDirectory`,
   `driveRootDirectory`) move out of the core schema here too, per seam 7.
   _Done when:_ reindexing a pre-extraction vault into the new store yields
   row-identical output to the old tables, and the old tables are no longer read
   by anything.
6. **RPC namespacing + contract relocation.** Aliases retained for a release.
   _Done when:_ a client one release behind (mobile) works against the aliases,
   and core `contracts` no longer exports memory types.

Steps 1–3 unblock scheduled prompts; 4 is user-visible value on its own; 5–6 are
the fork-hygiene payoff. If effort has to be cut, cut from the bottom, not the
top — but note that 4 before 5 is what makes 5 cheap, so do not reorder those.

One rollout caveat: steps 1–3 touch `ws.ts`, `ProviderCommandReactor`, and
`__root.tsx` — all upstream-active files — so this plan _increases_ merge surface
before it reduces it. Land each step whole and promptly; a half-landed step
sitting across an upstream merge is the worst of both worlds.

## The vault: make the whole app store rebuildable

Memory is one app containing two halves: a Zettelkasten vault of plain markdown,
and a `drive/` folder of artifacts pulled in from outside it (web fetches, script
output). Notes cite artifacts; that citation link is the point, which is why these
are one app and not two.

The organizing rule should be: **the filesystem is the truth, SQLite is a
disposable cache.** The notes half already works this way — `reindexAll` walks the
vault and rebuilds every row from frontmatter, and writes are file-first
specifically so a row that never landed is repaired on the next pass. Keep that
and extend it to the drive half.

Today the drive half breaks the rule. `ArtifactStore` writes the file, but
provenance (`thread_id`, `turn_id`, `checkpoint_ref`, `kind`) lives only in the
`drive_artifacts` row. Lose the database and you have anonymous files. Fix: write
a sidecar `<name>.meta.json` next to each artifact carrying exactly the row's
fields, and make the drive index rebuildable by walking the folder — the same
shape as frontmatter-driven note reindexing.

The payoff is disproportionate to the effort:

- **Per-app DB extraction stops needing a data migration.** Step 5 becomes
  "point at a new file, reindex" rather than a copy-forward with a correctness
  tail.
- **Backup and sync are "copy the folder."** Users will put this in Dropbox or a
  git repo — Obsidian users expect to — and that only works if the index is
  derived.
- **Corruption recovery is `rm state.sqlite`.** For a system whose whole value is
  accumulated notes, an unrecoverable index is a much worse failure than a slow
  rebuild.

### What is actually missing for Obsidian-like behavior

The indexing _model_ is right. Three gaps in the implementation — **all three are
in scope for this work, as step 4.** They are listed together because they share
one code path: each is a change to what reindex writes and what triggers it, so
doing them separately means touching the same reindex path three times.

1. **No full-text search.** `memory_search` currently delegates to `listNotes`,
   so it filters by tag and scope and never looks at note bodies. Add an FTS5
   virtual table over title and body, populated by the same reindex path. This is
   the single biggest capability gap and the cheapest to close — SQLite ships it.
2. **No file watcher.** Hand edits only surface when consolidation happens to run.
   Add a debounced watcher doing mtime-based incremental reindex, with full
   reindex on startup and a manual trigger as fallbacks. One `reindexAll` /
   `reindexPath` pair behind all three triggers — resist per-trigger logic.
   Because we explicitly encourage putting the vault in Dropbox or a git repo,
   the watcher must tolerate sync-tool behavior: burst writes, partially-written
   files, and unreliable mtimes. Debounce generously, treat a parse failure as
   "try again next event" rather than an error, and let the startup full reindex
   be the correctness backstop.
3. **Links resolve by id, not title.** Obsidian's `[[Some Title]]` is what people
   will type. That needs a title→id lookup and, importantly, tolerance for
   unresolved links: an unresolved `[[…]]` is a normal state meaning "note worth
   writing later", not an error to reject on write. Titles are not unique, so the
   collision rule is decided now: an ambiguous title resolves to the
   most-recently-modified match, and the index records the link as ambiguous so
   the UI can surface it. Never refuse the write.

One invariant covers the concurrency this section introduces: **all reindex paths
are idempotent and serialized behind a single lock.** Agents write files mid-turn
via the MCP tools, the watcher sees those same writes, and consolidation runs
`reindexAll` on its own schedule — three triggers racing over one corpus. They are
safe not by scheduling but because reindexing the same file twice is a no-op and
no two reindex passes run concurrently.

## User-defined apps without a rebuild

This is the requirement that shapes everything above, so it needs to be settled
now even though it is built last. Users cannot rebuild the web bundle, the
Electron app, or the mobile binary — so a user app can never be a React component
compiled into a surface. There are two populations of apps and they need different
delivery:

- **Built-ins** (memory, then schedule) — native React in the bundle, host API as
  a direct typed service call. Full fidelity, ships with the product.
- **User apps** — a folder the user drops in `<stateDir>/apps/<appId>/` containing
  a manifest and a self-contained HTML/JS page, served by the server and rendered
  in a sandboxed iframe (a WebView on mobile), talking to the host over
  `postMessage`.

The iframe is the recommendation for a specific reason: it is a sandbox we get for
free from the browser, and it matches what users will actually be producing. An
artifact-style single HTML file is already the natural output of asking an agent
for a small tool, which is exactly the "user created artifact apps" case.

**Both populations register through the same registry and use the same host API.**
The postMessage bridge is a _transport_ for the host API, not a second API. If
built-ins get a rich Effect-service host and user apps get some separate reduced
message protocol, they diverge immediately and every host capability gets built
twice.

That has one consequence worth acting on now, in step 1, because it is expensive
to retrofit: **design the host API as async, serializable, method-call shaped from
the start.** No passing functions or callbacks, no handing out DB handles or
`SqlClient`, no rich class instances in returns — nothing that cannot cross a
postMessage boundary. A host API designed only against in-process built-ins will
quietly acquire non-serializable signatures, and discovering that when the iframe
work starts means redesigning it with two consumers already attached.

Everything else about user apps — manifest schema, permission prompts, versioning,
what an app is allowed to ask the host for — stays deferred. The point of deciding
the shape now is that it costs one constraint on step 1 rather than a rewrite.

## What this deliberately does not do

- **No user-supplied server-side code.** User apps get a UI and the host API, not
  a process in the server. Dropping JS into the server process has no sandbox and
  full filesystem and provider-credential access; the iframe boundary is only
  meaningful if nothing bypasses it.
- **No iframe runtime yet.** Built-ins come first. Step 1's serializability
  constraint is what keeps the door open, and that is all that is needed until a
  built-in has proven the host API.
- **No per-app websocket or process.** Apps share the connection and the server
  process. Performance work on this layer is unwarranted until an app proves it
  needs it — and per the perf constraints in AGENTS.md, a new app pushing volume
  over the socket is a thing to measure, not a thing to pre-solve.
- **No app-visible access to the orchestration event log.** Apps get hooks and
  the host API. Handing out the log would make every app a de-facto projection
  and freeze the log's shape.

## Settled: surfaces and enablement scope

**Web and desktop only for now; mobile deliberately deferred.** The rail, the app
routes, and the workspace switch are not built for mobile in this work. Two
constraints follow from keeping mobile viable rather than merely possible:

- The rail is a _client_ concern. Nothing in the registry, the host API, the RPC
  groups, or the hooks may assume a rail exists or that a surface can render an
  app. A surface with no app UI must still serve an app's RPC without error, or
  mobile becomes a server change rather than a client one.
- Mobile's eventual path for user apps is the same iframe contract in a WebView,
  which is another reason the postMessage transport must not diverge from the
  in-process host API.

**`enabledApps` is per-environment, not per-device.** An app's store lives under
that environment's `stateDir` and its data is meaningless without it, so an app
enabled on a machine that has no store for it would be a broken rail entry. This
also settles a mobile question in advance: a phone connecting to an environment
sees that environment's app list, so when mobile UI does land it needs no new
sync model. Per-device settings exist in the codebase (see per-device provider
settings) and are the wrong fit here — that mechanism is for things that describe
the _client_, and an app list describes the environment's contents.

The one cost: a user with several environments enables an app once per
environment. That is the correct behavior, not a wart — the notes are per
environment too.
