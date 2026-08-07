import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as Crypto from "effect/Crypto";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  GitWorkflowService,
  OrchestrationEngineService,
  SqlClient.SqlClient,
  Crypto.Crypto,
];

/**
 * Note the absence of a `threadId` parameter.
 *
 * Which thread the link lands on comes from the invocation scope, exactly like
 * memory provenance: an agent that could name the thread could re-point another
 * thread's PR, and the whole reason this feature exists is that wrong
 * attachments are expensive to notice.
 */
export const ThreadLinkPullRequestInput = Schema.Struct({
  reference: Schema.String.pipe(
    Schema.annotate({
      description:
        "The pull request to attach: a number ('123'), '#123', a full PR/MR URL, or a 'gh pr checkout ...' command. Resolved against this thread's repository.",
    }),
  ),
});

export const ThreadLinkPullRequestResult = Schema.Struct({
  linked: Schema.Boolean,
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
});

export const ThreadUnlinkPullRequestInput = Schema.Struct({});

export const ThreadUnlinkPullRequestResult = Schema.Struct({
  unlinked: Schema.Boolean,
});

export const ThreadGetPullRequestInput = Schema.Struct({});

export const ThreadGetPullRequestResult = Schema.Struct({
  linked: Schema.Boolean,
  number: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});

export const ThreadLinkPullRequestTool = Tool.make("thread_link_pull_request", {
  description:
    "Attach a pull request to the current thread. Use after opening or identifying the PR this work belongs to -- the link is what drives the thread's PR badge and lets the thread settle itself when the PR merges or closes. Nothing is checked out and the working tree is untouched. Replaces any previously linked PR.",
  parameters: ThreadLinkPullRequestInput,
  success: ThreadLinkPullRequestResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Link a pull request to this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const ThreadUnlinkPullRequestTool = Tool.make("thread_unlink_pull_request", {
  description:
    "Detach the pull request currently linked to this thread. Use when the linked PR turned out to be the wrong one, or the work moved elsewhere.",
  parameters: ThreadUnlinkPullRequestInput,
  success: ThreadUnlinkPullRequestResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink this thread's pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const ThreadGetPullRequestTool = Tool.make("thread_get_pull_request", {
  description:
    "Read the pull request linked to this thread, if any. Use to avoid re-linking a PR that is already attached.",
  parameters: ThreadGetPullRequestInput,
  success: ThreadGetPullRequestResult,
  failure: McpCapabilityUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Read this thread's linked pull request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadToolkit = Toolkit.make(
  ThreadLinkPullRequestTool,
  ThreadUnlinkPullRequestTool,
  ThreadGetPullRequestTool,
);
