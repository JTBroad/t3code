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
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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

const PROVIDER = ProviderDriverKind.make("copilot");
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
    PROVIDER,
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
  return copilotSettings.homePath.length > 0
    ? { ...base, COPILOT_HOME: copilotSettings.homePath }
    : { ...base };
}

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
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute Copilot CLI health check.",
      },
    });
  }

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
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
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

  // Auth probe: `copilot auth status` exits non-zero when logged out.
  // (Verified surface may vary by CLI version — treat any failure as
  // "unknown" rather than "not authenticated" to avoid false negatives.)
  const authProbe = yield* runCopilotCommand(
    copilotSettings,
    ["auth", "status"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
    const auth = authProbe.success.value;
    if (auth.code === 0) {
      const email = parseCopilotAuthLogin(`${auth.stdout}\n${auth.stderr}`);
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "ready",
          auth: {
            status: "authenticated",
            ...(email ? { email } : {}),
          },
        },
      });
    }
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
        message: "Copilot CLI is installed but not logged in. Run `copilot` and authenticate.",
      },
    });
  }

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
});

/**
 * Extract a login/email hint from `copilot auth status` output. Output
 * shape is CLI-version dependent; we look for an email-like token and
 * otherwise a `Logged in as <login>` line.
 */
export function parseCopilotAuthLogin(output: string): string | undefined {
  const emailMatch = output.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) {
    return emailMatch[0];
  }
  const loginMatch = output.match(/logged in (?:to [^\s]+ )?as ([A-Za-z0-9-]+)/i);
  return loginMatch?.[1];
}

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
