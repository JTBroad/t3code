import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AppHost } from "../../../apps/AppHost.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// `AppHost` is how these tools reach core state (thread -> project attribution).
// `SqlClient` is still here for the app's own index, not for core tables -- see
// `ProjectResolution`, which no longer queries the projections directly.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  FileSystem.FileSystem,
  Path.Path,
  ServerConfig,
  ServerSettingsService,
  SqlClient.SqlClient,
  AppHost,
];

/**
 * Note the absence of any provenance parameter on `memory_append_daily`.
 *
 * Project, thread, and capture time come from the invocation scope on the
 * server. Exposing them as parameters would let a model set them, and a model
 * that can label an observation with the wrong project can quietly poison
 * recall for every other project.
 */
export const MemoryAppendDailyInput = Schema.Struct({
  body: Schema.String.pipe(
    Schema.annotate({
      description: "The observation to record, in plain prose. One idea per call.",
    }),
  ),
});

export const MemoryAppendDailyResult = Schema.Struct({
  recorded: Schema.Boolean,
  /** How many credentials were stripped. Never the values themselves. */
  redactionCount: Schema.Number,
});

export const MemoryReadDailyInput = Schema.Struct({});

export const MemoryReadDailyResult = Schema.Struct({
  contents: Schema.String,
});

export const MemorySearchInput = Schema.Struct({
  tag: Schema.optional(
    Schema.String.pipe(Schema.annotate({ description: "Only notes carrying this tag." })),
  ),
  scope: Schema.optional(
    Schema.Literals(["global", "project"]).pipe(
      Schema.annotate({ description: "Restrict to user-level or project-level notes." }),
    ),
  ),
  limit: Schema.optional(
    Schema.Number.pipe(
      Schema.annotate({ description: "Maximum notes to return. Defaults to 20." }),
    ),
  ),
});

export const MemorySearchResult = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      scope: Schema.String,
      tags: Schema.Array(Schema.String),
      modifiedAt: Schema.String,
    }),
  ),
});

export const MemoryAppendDailyTool = Tool.make("memory_append_daily", {
  description:
    "Record one observation worth remembering later -- a user preference, a project convention, something learned that should change future behavior. Capture is cheap and deliberately promiscuous: do not decide whether it is important enough to keep, a later consolidation pass does that with full context. Provenance is recorded automatically.",
  parameters: MemoryAppendDailyInput,
  success: MemoryAppendDailyResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Record an observation")
  .annotate(Tool.Destructive, false);

export const MemoryReadDailyTool = Tool.make("memory_read_daily", {
  description:
    "Read observations captured since the last consolidation. Use to avoid recording something already noted.",
  parameters: MemoryReadDailyInput,
  success: MemoryReadDailyResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Read recent observations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MemorySearchTool = Tool.make("memory_search", {
  description:
    "Search permanent notes by tag and scope. Notes for the current project rank ahead of user-level ones.",
  parameters: MemorySearchInput,
  success: MemorySearchResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Search memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/**
 * Note the absence of a `projectSegment` parameter here too.
 *
 * The bucket an artifact lands in is derived from the invocation scope, for the
 * same reason capture provenance is: a model that can choose the folder can
 * write into another project's drive.
 */
export const DriveWriteArtifactInput = Schema.Struct({
  relativePath: Schema.String.pipe(
    Schema.annotate({
      description:
        "Path within this project's drive folder, e.g. '2026-08-01/review-notes.md'. Must not escape the folder.",
    }),
  ),
  contents: Schema.String.pipe(Schema.annotate({ description: "Full file contents to write." })),
  kind: Schema.optional(
    Schema.String.pipe(
      Schema.annotate({ description: "What this is: 'report', 'export', 'scratch'." }),
    ),
  ),
});

export const DriveWriteArtifactResult = Schema.Struct({
  id: Schema.String,
  relativePath: Schema.String,
  byteSize: Schema.Number,
});

export const DriveWriteArtifactTool = Tool.make("drive_write_artifact", {
  description:
    "Write a generated file that should not be committed to the repository -- a report, an export, scratch output. The file is stored outside every workspace and indexed so later notes can cite it. Use instead of writing throwaway files into the user's project.",
  parameters: DriveWriteArtifactInput,
  success: DriveWriteArtifactResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Write a drive artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const MemoryToolkit = Toolkit.make(
  MemoryAppendDailyTool,
  MemoryReadDailyTool,
  MemorySearchTool,
  DriveWriteArtifactTool,
);
