import { describe, expect, it } from "@effect/vitest";

import {
  mapCopilotPermissionKindToRequestType,
  normalizeCopilotAgentSelection,
  readCopilotResumeState,
  summarizeCopilotPermissionRequest,
  toCopilotToolLifecycleItemType,
  toProviderCustomAgents,
} from "./CopilotAdapter.ts";
import { copilotModelsFromModelInfo } from "./CopilotProvider.ts";

describe("toCopilotToolLifecycleItemType", () => {
  it("classifies shell tools as command_execution", () => {
    expect(toCopilotToolLifecycleItemType("shell")).toBe("command_execution");
    expect(toCopilotToolLifecycleItemType("run_terminal_command")).toBe("command_execution");
  });

  it("classifies file edits as file_change", () => {
    expect(toCopilotToolLifecycleItemType("edit_file")).toBe("file_change");
    expect(toCopilotToolLifecycleItemType("write_file")).toBe("file_change");
    expect(toCopilotToolLifecycleItemType("create_file")).toBe("file_change");
  });

  it("prefers mcp_tool_call when an MCP server is present", () => {
    expect(toCopilotToolLifecycleItemType("edit_file", "t3-code")).toBe("mcp_tool_call");
  });

  it("classifies web and agent tools", () => {
    expect(toCopilotToolLifecycleItemType("web_fetch")).toBe("web_search");
    expect(toCopilotToolLifecycleItemType("task_agent")).toBe("collab_agent_tool_call");
  });

  it("falls back to dynamic_tool_call", () => {
    expect(toCopilotToolLifecycleItemType("lookup_issue")).toBe("dynamic_tool_call");
  });
});

describe("mapCopilotPermissionKindToRequestType", () => {
  it("maps documented kinds to canonical request types", () => {
    expect(mapCopilotPermissionKindToRequestType("shell")).toBe("command_execution_approval");
    expect(mapCopilotPermissionKindToRequestType("write")).toBe("file_change_approval");
    expect(mapCopilotPermissionKindToRequestType("read")).toBe("file_read_approval");
  });

  it("default-cases unknown kinds (open-ended union)", () => {
    expect(mapCopilotPermissionKindToRequestType("mcp")).toBe("unknown");
    expect(mapCopilotPermissionKindToRequestType("some-future-kind")).toBe("unknown");
  });
});

describe("summarizeCopilotPermissionRequest", () => {
  it("summarizes shell requests with the full command text", () => {
    const summary = summarizeCopilotPermissionRequest({
      kind: "shell",
      fullCommandText: "rm -rf ./dist",
    } as never);
    expect(summary).toBe("rm -rf ./dist");
  });

  it("summarizes write requests with the file name", () => {
    const summary = summarizeCopilotPermissionRequest({
      kind: "write",
      fileName: "src/index.ts",
    } as never);
    expect(summary).toBe("Write src/index.ts");
  });

  it("summarizes unknown kinds with kind + tool name", () => {
    const summary = summarizeCopilotPermissionRequest({
      kind: "mcp",
      toolName: "create_issue",
    } as never);
    expect(summary).toBe("mcp: create_issue");
  });
});

describe("readCopilotResumeState", () => {
  it("reads a persisted copilotSessionId", () => {
    expect(readCopilotResumeState({ copilotSessionId: "abc-123" })).toEqual({
      copilotSessionId: "abc-123",
    });
  });

  it("rejects malformed cursors", () => {
    expect(readCopilotResumeState(undefined)).toBeUndefined();
    expect(readCopilotResumeState("abc")).toBeUndefined();
    expect(readCopilotResumeState({ copilotSessionId: "" })).toBeUndefined();
    expect(readCopilotResumeState({ other: true })).toBeUndefined();
  });
});

describe("normalizeCopilotAgentSelection", () => {
  it("passes through custom agent names", () => {
    expect(normalizeCopilotAgentSelection("code-reviewer")).toBe("code-reviewer");
    expect(normalizeCopilotAgentSelection("  spaced  ")).toBe("spaced");
  });

  it("normalizes absent/default selections to undefined", () => {
    expect(normalizeCopilotAgentSelection(undefined)).toBeUndefined();
    expect(normalizeCopilotAgentSelection("")).toBeUndefined();
    expect(normalizeCopilotAgentSelection("   ")).toBeUndefined();
    expect(normalizeCopilotAgentSelection("default")).toBeUndefined();
  });
});

describe("toProviderCustomAgents", () => {
  it("maps SDK AgentInfo entries to the contract shape", () => {
    expect(
      toProviderCustomAgents([
        {
          name: "code-reviewer",
          displayName: "Code Reviewer",
          description: "Reviews diffs",
          source: "project",
          userInvocable: true,
        },
      ]),
    ).toEqual([
      {
        name: "code-reviewer",
        displayName: "Code Reviewer",
        description: "Reviews diffs",
        source: "project",
      },
    ]);
  });

  it("filters non-invocable agents and reserved/empty names", () => {
    expect(
      toProviderCustomAgents([
        { name: "hidden", displayName: "Hidden", userInvocable: false },
        { name: "", displayName: "Empty" },
        { name: "default", displayName: "Reserved" },
      ]),
    ).toEqual([]);
  });

  it("falls back to name for missing displayName and unknown for odd sources", () => {
    expect(toProviderCustomAgents([{ name: "docs", source: "martian" }])).toEqual([
      { name: "docs", displayName: "docs", source: "unknown" },
    ]);
  });

  it("tolerates undefined agent lists", () => {
    expect(toProviderCustomAgents(undefined)).toEqual([]);
  });
});

describe("copilotModelsFromModelInfo", () => {
  it("maps ModelInfo with reasoning effort into option descriptors", () => {
    const models = copilotModelsFromModelInfo([
      {
        id: "gpt-5",
        name: "GPT-5",
        capabilities: {
          supports: { vision: false, reasoningEffort: true },
          limits: { max_context_window_tokens: 200000 },
        },
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      } as never,
    ]);
    expect(models).toHaveLength(1);
    const model = models[0]!;
    expect(model.slug).toBe("gpt-5");
    expect(model.isCustom).toBe(false);
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0]!;
    expect(descriptor.id).toBe("reasoningEffort");
    if (descriptor.type === "select") {
      expect(descriptor.options.map((option) => option.id)).toEqual(["low", "medium", "high"]);
      expect(descriptor.options.find((option) => option.isDefault)?.id).toBe("medium");
    } else {
      throw new Error("expected select descriptor");
    }
  });

  it("omits descriptors for models without reasoning effort", () => {
    const models = copilotModelsFromModelInfo([
      {
        id: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        capabilities: {
          supports: { vision: true, reasoningEffort: false },
          limits: { max_context_window_tokens: 200000 },
        },
      } as never,
    ]);
    expect(models[0]?.capabilities?.optionDescriptors ?? []).toHaveLength(0);
  });
});
