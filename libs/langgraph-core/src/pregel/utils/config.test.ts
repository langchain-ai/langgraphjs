import { describe, beforeEach, afterAll, it, expect, vi } from "vitest";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import {
  ensureLangGraphConfig,
  getStore,
  getWriter,
  getConfig,
  recastCheckpointNamespace,
  getParentCheckpointNamespace,
} from "./config.js";
import {
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CHECKPOINT_NAMESPACE_END,
} from "../../constants.js";

describe("ensureLangGraphConfig", () => {
  // Save original to restore after tests
  const originalGetRunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig;

  beforeEach(() => {
    // Reset the mock before each test
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi.fn();
  });

  afterAll(() => {
    // Restore the original after all tests
    AsyncLocalStorageProviderSingleton.getRunnableConfig =
      originalGetRunnableConfig;
  });

  it("should return a default config when no arguments provided", () => {
    // Mock the AsyncLocalStorage to return undefined
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const result = ensureLangGraphConfig();

    expect(result).toEqual({
      tags: [],
      metadata: {},
      callbacks: undefined,
      recursionLimit: 25,
      configurable: {},
    });
  });

  it("should merge multiple configs per-key, preserving distinct keys", () => {
    // Mock the AsyncLocalStorage to return undefined
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config1 = {
      tags: ["tag1"],
      metadata: { key1: "value1" },
      configurable: { option1: "value1" },
    };

    const config2 = {
      tags: ["tag2"],
      metadata: { key2: "value2" },
      configurable: { option2: "value2" },
    };

    const result = ensureLangGraphConfig(config1, config2);

    // tags/metadata/configurable now merge across configs rather than
    // overwriting (matches langgraph's `merge_configs`).
    expect(result).toEqual({
      tags: ["tag1", "tag2"],
      metadata: { key1: "value1", key2: "value2" },
      callbacks: undefined,
      recursionLimit: 25,
      configurable: { option1: "value1", option2: "value2" },
    });
  });

  it("should merge configurable dicts, with later configs winning per key", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const bound = { configurable: { ls_agent_type: "root", shared: "from_a" } };
    const invoke = { configurable: { thread_id: "T1", shared: "from_b" } };

    const result = ensureLangGraphConfig(bound, invoke);

    expect(result.configurable).toEqual({
      ls_agent_type: "root",
      thread_id: "T1",
      shared: "from_b",
    });
  });

  it("should merge metadata dicts, with later configs winning per key", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const bound = { metadata: { user_id: "U1", shared: "from_a" } };
    const invoke = { metadata: { correlation_id: "C1", shared: "from_b" } };

    const result = ensureLangGraphConfig(bound, invoke);

    expect(result.metadata).toEqual({
      user_id: "U1",
      correlation_id: "C1",
      shared: "from_b",
    });
  });

  it("should concat tags across configs, preserving order and duplicates", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const result = ensureLangGraphConfig(
      { tags: ["shared", "alpha"] },
      { tags: ["shared", "beta"] }
    );

    // Plain concat (no dedup, no sort) — matches langgraph's `merge_configs`.
    expect(result.tags).toEqual(["shared", "alpha", "shared", "beta"]);
  });

  it("should concat callbacks arrays across configs, preserving handlers", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    class SentinelHandler extends BaseCallbackHandler {
      name = "sentinel";
    }
    const cbA = new SentinelHandler();
    const cbB = new SentinelHandler();

    const result = ensureLangGraphConfig(
      { callbacks: [cbA] },
      { callbacks: [cbB] }
    );

    expect(result.callbacks).toEqual([cbA, cbB]);
  });

  it("should merge tags and metadata (incl. inheritable) when both callbacks are managers", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const baseManager = new CallbackManager();
    baseManager.addTags(["base-inheritable"], true);
    baseManager.addTags(["base-local"], false);
    baseManager.addMetadata({ base_inheritable: "base" }, true);
    baseManager.addMetadata({ base_local: "base" }, false);

    const providedManager = new CallbackManager();
    providedManager.addTags(["provided-inheritable"], true);
    providedManager.addTags(["provided-local"], false);
    providedManager.addMetadata({ provided_inheritable: "provided" }, true);
    providedManager.addMetadata({ provided_local: "provided" }, false);

    const result = ensureLangGraphConfig(
      { callbacks: baseManager },
      { callbacks: providedManager }
    );

    const merged = result.callbacks as CallbackManager;
    expect(merged).toBeInstanceOf(CallbackManager);

    // inheritableMetadata must be carried over so child managers (nested
    // graph/tool/model runs) keep inheriting it.
    expect(merged.inheritableMetadata).toEqual({
      base_inheritable: "base",
      provided_inheritable: "provided",
    });
    expect(merged.metadata).toEqual({
      base_inheritable: "base",
      base_local: "base",
      provided_inheritable: "provided",
      provided_local: "provided",
    });
    expect(merged.inheritableTags).toEqual([
      "base-inheritable",
      "provided-inheritable",
    ]);
  });

  it("should not mutate the input configs when merging", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const bound = {
      metadata: { user_id: "U1" },
      configurable: { ls_agent_type: "root" },
      tags: ["bound"],
    };
    const invoke = {
      metadata: { correlation_id: "C1" },
      // `thread_id` is propagated into metadata, which previously mutated
      // the shared base config's metadata dict by reference.
      configurable: { thread_id: "T1" },
      tags: ["invoke"],
    };

    ensureLangGraphConfig(bound, invoke);

    expect(bound.metadata).toEqual({ user_id: "U1" });
    expect(bound.configurable).toEqual({ ls_agent_type: "root" });
    expect(bound.tags).toEqual(["bound"]);
    expect(invoke.metadata).toEqual({ correlation_id: "C1" });
    expect(invoke.configurable).toEqual({ thread_id: "T1" });
  });

  it("should copy values from AsyncLocalStorage if available", () => {
    // Mock values from AsyncLocalStorage
    const asyncLocalStorageConfig = {
      tags: ["storage-tag"],
      metadata: { storage: "value" },
      callbacks: { copy: () => ({ type: "copied-callback" }) },
      configurable: { storageOption: "value" },
    };

    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(asyncLocalStorageConfig);

    const result = ensureLangGraphConfig();

    expect(result.tags).toEqual(["storage-tag"]);
    expect(result.metadata || {}).toEqual({
      storage: "value",
    });
    expect(result.configurable).toEqual({ storageOption: "value" });
    expect(result.callbacks).toEqual({ type: "copied-callback" });
  });

  it("should handle undefined config values", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config1 = undefined;
    const config2 = {
      tags: ["tag2"],
      metadata: undefined,
    };

    const result = ensureLangGraphConfig(config1, config2);

    expect(result.tags).toEqual(["tag2"]);
    expect(result.metadata).toEqual({});
  });

  it("should only copy allowlisted configurable values to metadata", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      configurable: {
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        checkpoint_ns: "checkpoint-ns",
        task_id: "task-1",
        run_id: "run-1",
        assistant_id: "assistant-1",
        graph_id: "graph-1",
        stringValue: "string",
        objectValue: { should: "not be copied" },
        __privateValue: "should not be copied",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata).toEqual({
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      checkpoint_ns: "checkpoint-ns",
      task_id: "task-1",
      run_id: "run-1",
      assistant_id: "assistant-1",
      graph_id: "graph-1",
    });
  });

  it("should not overwrite existing metadata values with configurable values", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      metadata: { key: "original value" },
      configurable: {
        key: "should not overwrite",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata?.key).toEqual("original value");
  });

  it("should propagate empty checkpoint_ns to metadata", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      configurable: {
        thread_id: "thread-1",
        checkpoint_ns: "",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata).toEqual({
      thread_id: "thread-1",
      checkpoint_ns: "",
    });
  });

  it("should not inherit implicit configurable on root-level invoke with thread_id", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          thread_id: "stale-thread",
          __pregel_scratchpad__: { currentTaskInput: { secret: "leaked" } },
        },
      });

    const bound = { configurable: { ls_agent_type: "chatbot" } };
    const result = ensureLangGraphConfig(bound, {
      configurable: { thread_id: "fresh-thread" },
    });

    expect(result.configurable).toEqual({
      ls_agent_type: "chatbot",
      thread_id: "fresh-thread",
    });
    expect(
      (result.configurable as Record<string, unknown>).__pregel_scratchpad__
    ).toBeUndefined();
  });

  it("drops stale user custom implicit configurable keys on root-level invoke", () => {
    // The ambient `configurable` may belong to another concurrent invocation,
    // so arbitrary user keys (tenant_id/user_id) must NOT leak into run B.
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          thread_id: "stale-thread",
          __pregel_scratchpad__: { currentTaskInput: { secret: "leaked" } },
          tenant_id: "tenant-42",
          user_id: "user-A",
        },
      });

    const result = ensureLangGraphConfig(
      { configurable: { ls_agent_type: "chatbot" } },
      { configurable: { thread_id: "fresh-thread" } }
    );

    // Only the bound (`ls_agent_type`) and invoke-time (`thread_id`) keys
    // survive — nothing from the stale ambient configurable.
    expect(result.configurable).toEqual({
      ls_agent_type: "chatbot",
      thread_id: "fresh-thread",
    });
  });

  it("does not strip implicit configurable during RunnableCallable node execution", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          thread_id: "stale-thread",
          __pregel_scratchpad__: { currentTaskInput: { secret: "leaked" } },
        },
      });

    const taskConfig = {
      configurable: {
        thread_id: "task-thread",
        __pregel_read__: () => null,
        __pregel_scratchpad__: { currentTaskInput: { ok: true } },
      },
    };

    const result = ensureLangGraphConfig(taskConfig);

    expect(result.configurable).toEqual({
      thread_id: "task-thread",
      __pregel_read__: expect.any(Function),
      __pregel_scratchpad__: { currentTaskInput: { ok: true } },
    });
  });

  it("does not strip when streamEvents-style options include ambient nesting keys", () => {
    const ambientRead = () => null;
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          thread_id: "parent-thread",
          __pregel_read__: ambientRead,
          checkpoint_ns: "parent:1",
          __pregel_scratchpad__: { currentTaskInput: { from: "parent" } },
        },
      });

    const bound = { configurable: { thread_id: "bound-thread" } };
    // Mirrors Pregel.stream(): ambient nesting keys are merged into options
    // before _streamIterator → ensureLangGraphConfig(this.config, options).
    const streamEventsOptions = {
      configurable: {
        __pregel_read__: ambientRead,
        checkpoint_ns: "parent:1",
        __pregel_scratchpad__: { currentTaskInput: { from: "parent" } },
        ...bound.configurable,
        ls_agent_type: "sub-agent",
      },
    };

    const result = ensureLangGraphConfig(bound, streamEventsOptions);

    expect(result.configurable).toEqual({
      thread_id: "bound-thread",
      __pregel_read__: ambientRead,
      checkpoint_ns: "parent:1",
      __pregel_scratchpad__: { currentTaskInput: { from: "parent" } },
      ls_agent_type: "sub-agent",
    });
  });

  it("should inherit ambient nesting when bound config has thread_id but invoke does not", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          thread_id: "parent-thread",
          __pregel_read__: () => null,
          checkpoint_ns: "parent:1",
          __pregel_scratchpad__: { currentTaskInput: { from: "parent" } },
        },
      });

    const bound = { configurable: { thread_id: "bound-thread" } };
    const result = ensureLangGraphConfig(bound, {
      configurable: { ls_agent_type: "sub-agent" },
    });

    expect(result.configurable).toEqual({
      thread_id: "bound-thread",
      __pregel_read__: expect.any(Function),
      checkpoint_ns: "parent:1",
      __pregel_scratchpad__: { currentTaskInput: { from: "parent" } },
      ls_agent_type: "sub-agent",
    });
  });

  it("should still inherit implicit configurable for nested invokes", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          thread_id: "parent-thread",
          __pregel_read__: () => null,
          checkpoint_ns: "parent:1",
        },
      });

    const result = ensureLangGraphConfig({
      configurable: { ls_agent_type: "sub-agent" },
    });

    expect(result.configurable).toEqual({
      thread_id: "parent-thread",
      __pregel_read__: expect.any(Function),
      checkpoint_ns: "parent:1",
      ls_agent_type: "sub-agent",
    });
  });
});

describe("getStore, getWriter, getConfig", () => {
  // Save original to restore after tests
  const originalGetRunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig;

  beforeEach(() => {
    // Reset the mock before each test
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi.fn();
  });

  afterAll(() => {
    // Restore the original after all tests
    AsyncLocalStorageProviderSingleton.getRunnableConfig =
      originalGetRunnableConfig;
  });

  it("getStore should return store from config", () => {
    const mockStore = {} as BaseStore;
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        store: mockStore,
      });

    const result = getStore();

    expect(result).toBe(mockStore);
  });

  it("getWriter should return writer from configurable", () => {
    const mockWriter = () => { };
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue({
        configurable: {
          writer: mockWriter,
        },
      });

    const result = getWriter();

    expect(result).toBe(mockWriter);
  });

  it("getConfig should return the full config", () => {
    const mockConfig = { key: "value" };
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(mockConfig);

    const result = getConfig();

    expect(result).toBe(mockConfig);
  });
});

describe("recastCheckpointNamespace", () => {
  it("should filter out numeric parts of the namespace", () => {
    const namespace = `parent${CHECKPOINT_NAMESPACE_SEPARATOR}123${CHECKPOINT_NAMESPACE_SEPARATOR}child`;
    const result = recastCheckpointNamespace(namespace);

    expect(result).toBe(`parent${CHECKPOINT_NAMESPACE_SEPARATOR}child`);
  });

  it("should remove parts after CHECKPOINT_NAMESPACE_END", () => {
    const namespace = `part1${CHECKPOINT_NAMESPACE_SEPARATOR}part2${CHECKPOINT_NAMESPACE_END}extra`;
    const result = recastCheckpointNamespace(namespace);

    expect(result).toBe(`part1${CHECKPOINT_NAMESPACE_SEPARATOR}part2`);
  });

  it("should handle complex namespace with numeric parts and CHECKPOINT_NAMESPACE_END", () => {
    const namespace = `root${CHECKPOINT_NAMESPACE_SEPARATOR}123${CHECKPOINT_NAMESPACE_SEPARATOR}child${CHECKPOINT_NAMESPACE_END}extra${CHECKPOINT_NAMESPACE_SEPARATOR}456`;
    const result = recastCheckpointNamespace(namespace);

    expect(result).toBe(`root${CHECKPOINT_NAMESPACE_SEPARATOR}child`);
  });

  it("should return the original namespace when no filtering needed", () => {
    const namespace = `part1${CHECKPOINT_NAMESPACE_SEPARATOR}part2`;
    const result = recastCheckpointNamespace(namespace);

    expect(result).toBe(namespace);
  });
});

describe("getParentCheckpointNamespace", () => {
  it("should return the parent namespace by removing the last part", () => {
    const namespace = `parent${CHECKPOINT_NAMESPACE_SEPARATOR}child`;
    const result = getParentCheckpointNamespace(namespace);

    expect(result).toBe("parent");
  });

  it("should skip trailing numeric parts", () => {
    const namespace = `parent${CHECKPOINT_NAMESPACE_SEPARATOR}child${CHECKPOINT_NAMESPACE_SEPARATOR}123${CHECKPOINT_NAMESPACE_SEPARATOR}456`;
    const result = getParentCheckpointNamespace(namespace);

    expect(result).toBe("parent");
  });

  it("should return empty string for top-level namespace", () => {
    const namespace = "singlePart";
    const result = getParentCheckpointNamespace(namespace);

    expect(result).toBe("");
  });

  it("should handle namespace with mixed numeric and non-numeric parts", () => {
    const namespace = `root${CHECKPOINT_NAMESPACE_SEPARATOR}sub1${CHECKPOINT_NAMESPACE_SEPARATOR}123${CHECKPOINT_NAMESPACE_SEPARATOR}sub2`;
    const result = getParentCheckpointNamespace(namespace);

    // The implementation stops at the first numeric part, not at the last non-numeric part
    expect(result).toBe(
      `root${CHECKPOINT_NAMESPACE_SEPARATOR}sub1${CHECKPOINT_NAMESPACE_SEPARATOR}123`
    );
  });
});
