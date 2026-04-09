import { describe, beforeEach, afterAll, it, expect, vi } from "vitest";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
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

  it("should merge multiple configs, with later configs taking precedence", () => {
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

    // The implementation completely replaces objects rather than merging them.
    // Only allowlisted configurable keys are propagated to metadata.
    expect(result).toEqual({
      tags: ["tag2"],
      metadata: { key2: "value2" },
      callbacks: undefined,
      recursionLimit: 25,
      configurable: { option2: "value2" },
    });
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
    // Only allowlisted keys from configurable are copied to metadata
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

  it("should only copy allowlisted configurable keys to metadata", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      configurable: {
        thread_id: "th-123",
        checkpoint_id: "ckpt-1",
        checkpoint_ns: "ns-1",
        task_id: "task-1",
        run_id: "run-456",
        assistant_id: "asst-789",
        graph_id: "graph-0",
        cron_id: "cron-1",
        // These should NOT be copied to metadata
        model: "gpt-4o",
        user_id: "uid-1",
        langgraph_auth_user_id: "user-1",
        some_api_key: "secret",
        custom_setting: 42,
        objectValue: { should: "not be copied" },
        __privateValue: "should not be copied",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata).toEqual({
      thread_id: "th-123",
      checkpoint_id: "ckpt-1",
      checkpoint_ns: "ns-1",
      task_id: "task-1",
      run_id: "run-456",
      assistant_id: "asst-789",
      graph_id: "graph-0",
      cron_id: "cron-1",
    });
  });

  it("should not overwrite existing metadata values with configurable values", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      metadata: { thread_id: "original value" },
      configurable: {
        thread_id: "should not overwrite",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata?.thread_id).toEqual("original value");
  });

  it("should propagate all allowlisted configurable keys to metadata", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      configurable: {
        thread_id: "th-123",
        checkpoint_id: "ckpt-1",
        checkpoint_ns: "ns-1",
        task_id: "task-1",
        run_id: "run-456",
        assistant_id: "asst-789",
        graph_id: "graph-0",
        cron_id: "cron-1",
        // non-allowlisted keys
        model: "gpt-4o",
        user_id: "uid-1",
        langgraph_auth_user_id: "user-1",
        some_api_key: "secret",
        custom_setting: { nested: true },
      },
      metadata: { nooverride: 18 },
    };

    const result = ensureLangGraphConfig(config);

    // Allowlisted keys should be in metadata
    expect(result.metadata).toEqual({
      nooverride: 18,
      thread_id: "th-123",
      checkpoint_id: "ckpt-1",
      checkpoint_ns: "ns-1",
      task_id: "task-1",
      run_id: "run-456",
      assistant_id: "asst-789",
      graph_id: "graph-0",
      cron_id: "cron-1",
    });

    // Non-allowlisted keys should NOT appear
    expect(result.metadata).not.toHaveProperty("model");
    expect(result.metadata).not.toHaveProperty("user_id");
    expect(result.metadata).not.toHaveProperty("langgraph_auth_user_id");
    expect(result.metadata).not.toHaveProperty("some_api_key");
    expect(result.metadata).not.toHaveProperty("custom_setting");
  });

  it("should not overwrite metadata with allowlisted configurable keys", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      configurable: {
        thread_id: "from-configurable",
        run_id: "from-configurable",
      },
      metadata: {
        thread_id: "from-metadata",
        run_id: "from-metadata",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata).toEqual({
      thread_id: "from-metadata",
      run_id: "from-metadata",
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
    const mockWriter = () => {};
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
