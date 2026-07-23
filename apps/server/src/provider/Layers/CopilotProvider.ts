/**
 * CopilotProvider — snapshot probe + model catalog for the GitHub Copilot
 * driver.
 *
 * Modeled on `ClaudeProvider`: exports a `checkCopilotProviderStatus`
 * effect that probes the Copilot CLI (install/version/auth) and a
 * `makePendingCopilotProvider` builder for the initial "checking…"
 * snapshot. The driver (`CopilotDriver`) stamps instance identity on the
 * resulting drafts.
 *
 * @module provider/Layers/CopilotProvider
 */
import {
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  CopilotClient,
  RuntimeConnection,
  type GetAuthStatusResponse,
  type ModelInfo,
} from "@github/copilot-sdk";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const COPILOT_PRESENTATION = {
  displayName: "Copilot",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const REASONING_EFFORT_DESCRIPTOR = buildSelectOptionDescriptor({
  id: "reasoningEffort",
  label: "Reasoning",
  options: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
});

/**
 * Static fallback catalog. Replaced by the dynamic `listModels()` catalog
 * once a session-backed probe lands (Phase 6); until then these mirror the
 * models the Copilot CLI ships with by default.
 */
export const BUILT_IN_COPILOT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [REASONING_EFFORT_DESCRIPTOR],
    }),
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 mini",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [REASONING_EFFORT_DESCRIPTOR],
    }),
  },
  {
    slug: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

export function copilotModelsFromSettings(
  copilotSettings: CopilotSettings,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_COPILOT_MODELS,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );
}

/**
 * Build the environment for spawning the Copilot CLI. `homePath` maps to
 * `COPILOT_HOME`, mirroring the SDK's `baseDirectory` option, so a custom
 * data directory isolates accounts per instance.
 */
export function makeCopilotEnvironment(
  copilotSettings: CopilotSettings,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const base = environment ?? process.env;
  return {
    ...base,
    ...(copilotSettings.homePath.length > 0 ? { COPILOT_HOME: copilotSettings.homePath } : {}),
  };
}

export interface CopilotProbedSkill {
  readonly name: string;
  readonly description: string;
  readonly userInvocable: boolean;
}

export interface CopilotCapabilitiesProbe {
  readonly auth: GetAuthStatusResponse;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly skills: ReadonlyArray<CopilotProbedSkill>;
}

const CAPABILITIES_PROBE_TIMEOUT_MS = 30_000;

/**
 * Resolve the native `copilot` executable inside the SDK-bundled platform
 * package (`@github/copilot-<platform>-<arch>`).
 *
 * We must pass this explicitly: the SDK's own fallback resolves the
 * platform package's `index.js` and spawns it with `process.execPath` —
 * which is only correct when the host process runs under plain Node. The
 * t3code server runs under the Vite+ (`vp`) runtime, whose `execPath` is
 * the `vp` binary, so the SDK would effectively run `vp index.js …` and
 * the CLI never starts ("too many arguments. Expected 0 arguments").
 * Spawning the native binary sidesteps the host runtime entirely.
 */
export function resolveBundledCopilotBinaryPath(): string | undefined {
  const variants = process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];

  // The platform packages are transitive deps of `@github/copilot-sdk`,
  // so with pnpm's strict layout they are only resolvable from the SDK's
  // own location. Their root export (".") maps straight to the native
  // `copilot` executable.
  let require = NodeModule.createRequire(import.meta.url);
  try {
    require = NodeModule.createRequire(require.resolve("@github/copilot-sdk"));
  } catch {
    // SDK entry not resolvable from here — fall through with the local require.
  }

  for (const variant of variants) {
    const packageName = `@github/copilot-${variant}-${process.arch}`;
    try {
      const binary = require.resolve(packageName);
      if (NodeFS.existsSync(binary)) {
        return binary;
      }
    } catch {
      // Platform package not installed for this variant — try the next.
    }
  }
  return undefined;
}

/**
 * Build `CopilotClientOptions` shared by the probe, the adapter, and text
 * generation. A non-default `binaryPath` routes the SDK at the
 * user-installed CLI via `RuntimeConnection.forStdio`; the default routes
 * at the bundled native binary (see {@link resolveBundledCopilotBinaryPath}).
 */
export function makeCopilotClientOptions(
  copilotSettings: CopilotSettings,
  environment?: NodeJS.ProcessEnv,
): ConstructorParameters<typeof CopilotClient>[0] {
  const env = makeCopilotEnvironment(copilotSettings, environment) as Record<
    string,
    string | undefined
  >;
  const cliPath =
    copilotSettings.binaryPath !== "copilot"
      ? copilotSettings.binaryPath
      : resolveBundledCopilotBinaryPath();
  return {
    env,
    ...(copilotSettings.homePath.length > 0 ? { baseDirectory: copilotSettings.homePath } : {}),
    ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
    // COPILOT_DEBUG=1 surfaces the runtime's own diagnostics (skill load
    // failures, config parsing, retrieval decisions) on the CLI's stderr,
    // which the SDK pipes through as "[CLI subprocess]" lines.
    logLevel: (env.COPILOT_DEBUG ? "debug" : "none") as "debug" | "none",
  };
}

/**
 * SDK-backed capabilities probe: starts a short-lived `CopilotClient`,
 * reads auth status + the dynamic model list, and shuts down. Returns
 * `undefined` on any failure or timeout so callers degrade to the static
 * catalog with `auth: unknown`.
 */
export const probeCopilotCapabilities = (
  copilotSettings: CopilotSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<CopilotCapabilitiesProbe | undefined> =>
  Effect.gen(function* () {
    const client = new CopilotClient(makeCopilotClientOptions(copilotSettings, environment));
    return yield* Effect.tryPromise(async () => {
      try {
        await client.start();
        const auth = await client.getAuthStatus();
        const models = auth.isAuthenticated ? await client.listModels() : [];
        // Personal/builtin user-invocable skills double as slash commands.
        // (Project skills are per-thread and can't live in the instance
        // snapshot; the runtime still expands them when typed manually.)
        let skills: Array<CopilotProbedSkill> = [];
        try {
          const session = await client.createSession({});
          try {
            const list = await session.rpc.skills.list();
            skills = (list.skills ?? []).map(
              (skill: { name: string; description: string; userInvocable: boolean }) => ({
                name: skill.name,
                description: skill.description,
                userInvocable: skill.userInvocable,
              }),
            );
          } finally {
            await session.disconnect().catch(() => undefined);
          }
        } catch {
          // Skill listing is best-effort; the provider works without it.
        }
        return { auth, models, skills } satisfies CopilotCapabilitiesProbe;
      } finally {
        await client.stop().catch(() => client.forceStop().catch(() => undefined));
      }
    });
  }).pipe(
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.flatMap((result) => {
      if (Result.isFailure(result)) {
        const cause = result.failure.cause;
        return Effect.logWarning("Copilot capabilities probe failed.", {
          detail: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
        }).pipe(Effect.as(undefined));
      }
      if (Option.isNone(result.success)) {
        return Effect.logWarning("Copilot capabilities probe timed out.", {
          timeoutMs: CAPABILITIES_PROBE_TIMEOUT_MS,
        }).pipe(Effect.as(undefined));
      }
      return Effect.succeed(result.success.value);
    }),
  );

/** Map SDK `ModelInfo` entries into the provider model catalog shape. */
export function copilotModelsFromModelInfo(
  models: ReadonlyArray<ModelInfo>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => ({
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors:
        model.capabilities.supports.reasoningEffort &&
        (model.supportedReasoningEfforts?.length ?? 0) > 0
          ? [
              buildSelectOptionDescriptor({
                id: "reasoningEffort",
                label: "Reasoning",
                options: (model.supportedReasoningEfforts ?? []).map((effort) => ({
                  value: effort,
                  label: REASONING_EFFORT_LABELS[effort] ?? effort,
                  ...(effort === model.defaultReasoningEffort ? { isDefault: true } : {}),
                })),
              }),
            ]
          : [],
    }),
  }));
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const runCopilotCommand = Effect.fn("runCopilotCommand")(function* (
  copilotSettings: CopilotSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const copilotEnvironment = makeCopilotEnvironment(copilotSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(copilotSettings.binaryPath, args, {
    env: copilotEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: copilotEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(copilotSettings.binaryPath, command);
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  resolveCapabilities?: (
    copilotSettings: CopilotSettings,
  ) => Effect.Effect<CopilotCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = copilotModelsFromSettings(copilotSettings);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runCopilotCommand(
    copilotSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    // A missing user-installed binary is not fatal: the SDK bundles the
    // CLI (`@github/copilot` dependency) and spawns it itself. Only treat
    // this as an error when a custom binaryPath was explicitly configured.
    const commandMissing = isCommandMissingCause(error);
    if (!commandMissing || copilotSettings.binaryPath !== "copilot") {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !commandMissing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: commandMissing
            ? `Copilot CLI ('${copilotSettings.binaryPath}') is not installed or not on PATH.`
            : "Failed to execute Copilot CLI health check.",
        },
      });
    }
  }

  let parsedVersion: string | null = null;
  if (Result.isSuccess(versionProbe)) {
    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Copilot CLI is installed but timed out while running the version probe.",
        },
      });
    }

    const version = versionProbe.success.value;
    parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (version.code !== 0) {
      yield* Effect.logWarning("Copilot CLI version probe exited with a non-zero status.", {
        exitCode: version.code,
        stdoutLength: version.stdout.length,
        stderrLength: version.stderr.length,
      });
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: "Copilot CLI is installed but failed to run.",
        },
      });
    }
  }

  // Auth + dynamic models via a short-lived SDK client (`auth.getStatus`
  // and `listModels` over JSON-RPC). Any failure degrades to the static
  // catalog with `auth: unknown` rather than a false "unauthenticated".
  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(copilotSettings).pipe(Effect.orElseSucceed(() => undefined))
    : yield* probeCopilotCapabilities(copilotSettings, resolvedEnvironment);

  if (!capabilities) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Copilot authentication status.",
      },
    });
  }

  if (!capabilities.auth.isAuthenticated) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          capabilities.auth.statusMessage ??
          "Copilot CLI is installed but not logged in. Run `copilot login` to authenticate.",
      },
    });
  }

  const dynamicModels =
    capabilities.models.length > 0
      ? providerModelsFromSettings(
          copilotModelsFromModelInfo(capabilities.models),
          copilotSettings.customModels,
          DEFAULT_COPILOT_MODEL_CAPABILITIES,
        )
      : models;

  const slashCommands = capabilities.skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    }));

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models: dynamicModels,
    slashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.auth.login ? { label: capabilities.auth.login } : {}),
        ...(capabilities.auth.authType ? { type: capabilities.auth.authType } : {}),
      },
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingCopilotProvider = (
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = copilotModelsFromSettings(copilotSettings);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Copilot CLI…",
      },
    });
  });
