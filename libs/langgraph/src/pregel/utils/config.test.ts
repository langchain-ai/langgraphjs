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

    // The implementation completely replaces objects rather than merging them
    expect(result).toEqual({
      tags: ["tag2"],
      metadata: { key2: "value2", option2: "value2" },
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
    expect(result.metadata || {}).toEqual({
      storage: "value",
      storageOption: "value",
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

  it("should copy scalar values to metadata from configurable", () => {
    AsyncLocalStorageProviderSingleton.getRunnableConfig = vi
      .fn()
      .mockReturnValue(undefined);

    const config = {
      configurable: {
        stringValue: "string",
        numberValue: 42,
        booleanValue: true,
        objectValue: { should: "not be copied" },
        __privateValue: "should not be copied",
      },
    };

    const result = ensureLangGraphConfig(config);

    expect(result.metadata).toEqual({
      stringValue: "string",
      numberValue: 42,
      booleanValue: true,
      // objectValue and __privateValue should not be copied
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
