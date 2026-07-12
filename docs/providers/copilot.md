# Copilot

GitHub Copilot support in T3 Code is built on the official
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk), which drives the
Copilot CLI over JSON-RPC. The SDK bundles the CLI, so a separate install is
optional.

## Requirements

- A GitHub account with Copilot access.
- Authenticate once via the Copilot CLI: run `copilot` (or `copilot login`) and
  complete the OAuth device flow. Headless setups can use the
  `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` environment variables
  instead.

## Settings

```text
Display name: Copilot
Binary path: copilot          # optional; empty uses the SDK-bundled CLI
COPILOT_HOME path: ~/.copilot # optional; isolates accounts/session state
```

- **Binary path** — point at a user-installed `copilot` binary. When left at
  the default and no binary is on PATH, the SDK-bundled CLI is used.
- **COPILOT_HOME path** — custom Copilot data directory (auth token fallback,
  session state, MCP config). Use different paths on multiple instances to keep
  accounts separate.

## Models

The model list is fetched dynamically from the CLI after authentication. Models
that support reasoning effort expose a `Reasoning` option (low / medium / high /
extra high) in the model picker. Additional model slugs can be added via
`customModels` in settings.

## Behavior notes

- Model switching is supported in-session; picking a new model applies to the
  next turn.
- Sessions persist on disk (`COPILOT_HOME/session-state`) and are resumed when
  a thread is reopened.
- In `approval-required` mode every tool run prompts; `auto-accept-edits`
  auto-approves file reads/writes but prompts for shell commands;
  `full-access` auto-approves everything.
- Copilot's infinite-session compaction runs automatically; compaction shows up
  as a context-compaction item in the thread and updates token usage.
