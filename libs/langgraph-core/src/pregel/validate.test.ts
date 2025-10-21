import { describe, expect, it } from "vitest";
import { type All } from "@langchain/langgraph-checkpoint";
import {
  GraphValidationError,
  validateGraph,
  validateKeys,
} from "./validate.js";
import { PregelNode } from "./read.js";
import { INTERRUPT } from "../constants.js";
import { LastValue } from "../channels/last_value.js";

// Define test graph types for proper type checking
type TestChannels = {
  input: LastValue<string>;
  output: LastValue<string>;
};

type TestNodes = {
  testNode: PregelNode;
};

// Common test setup
const setupValidGraph = () => {
  // Create test channels
  const inputChannel = new LastValue<string>();
  const outputChannel = new LastValue<string>();

  // Create test nodes
  const testNode = new PregelNode({
    channels: {},
    triggers: ["input"] as (keyof TestChannels)[],
  });

  return {
    nodes: { testNode } as TestNodes,
    channels: {
      input: inputChannel,
      output: outputChannel,
    } as TestChannels,
    inputChannels: "input" as keyof TestChannels,
    outputChannels: "output" as keyof TestChannels,
  };
};

describe("GraphValidationError", () => {
  it("should be properly constructed with the right name", () => {
    const error = new GraphValidationError("Test error message");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GraphValidationError");
    expect(error.message).toBe("Test error message");
  });
});

describe("validateGraph", () => {
  it("should validate a correct graph without errors", () => {
    const { nodes, channels, inputChannels, outputChannels } =
      setupValidGraph();

    // Act & Assert: Should not throw
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
      })
    ).not.toThrow();
  });

  it("should throw when channels are not provided", () => {
    const { nodes, inputChannels, outputChannels } = setupValidGraph();

    // Act & Assert: Should throw with specific message
    expect(() =>
      validateGraph({
        nodes,
        channels: null as unknown as Record<string, LastValue<string>>,
        inputChannels,
        outputChannels,
      })
    ).toThrow("Channels not provided");
  });

  it("should throw when a node is named INTERRUPT", () => {
    const { channels, inputChannels, outputChannels } = setupValidGraph();

    // Create a node with the reserved name
    const badNode = new PregelNode({
      channels: {},
      triggers: ["input"],
    });

    // Create nodes object with the reserved name
    const nodes = { [INTERRUPT]: badNode } as unknown as TestNodes;

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
      })
    ).toThrow(`"Node name ${INTERRUPT} is reserved"`);
  });

  it("should throw when a node is not a PregelNode instance", () => {
    const { channels, inputChannels, outputChannels } = setupValidGraph();

    // Create an invalid node (not a PregelNode)
    const badNode = {
      triggers: ["input"],
      func: () => "not a pregel node",
    };

    // Create nodes object with invalid node
    const nodes = {
      badNode: badNode as unknown as PregelNode,
    } as unknown as TestNodes;

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
      })
    ).toThrow("Invalid node type object, expected PregelNode");
  });

  it("should throw when a subscribed channel is not in channels", () => {
    const { channels, inputChannels, outputChannels } = setupValidGraph();

    // Create a node that subscribes to a non-existent channel
    const badNode = new PregelNode({
      channels: {},
      triggers: ["nonexistent"],
    });

    const nodes = { badNode } as unknown as TestNodes;

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
      })
    ).toThrow("Subscribed channel 'nonexistent' not in channels");
  });

  it("should throw when a singular input channel is not subscribed by any node", () => {
    const { nodes, channels } = setupValidGraph();

    // Act & Assert: Should throw specific error for an unused input
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels: "output", // not subscribed by any node
        outputChannels: "output",
      })
    ).toThrow("Input channel output is not subscribed to by any node");
  });

  it("should throw when none of the array input channels are subscribed by any node", () => {
    const { nodes, channels } = setupValidGraph();

    // Act & Assert: Should throw specific error for unused inputs
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels: [
          "output",
          "nonexistent",
        ] as unknown as (keyof TestChannels)[], // neither is subscribed
        outputChannels: "output",
      })
    ).toThrow(
      "None of the input channels output,nonexistent are subscribed to by any node"
    );
  });

  it("should throw when an output channel is not in channels", () => {
    const { nodes, channels, inputChannels } = setupValidGraph();

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels: "nonexistent" as unknown as keyof TestChannels,
      })
    ).toThrow("Output channel 'nonexistent' not in channels");
  });

  it("should throw when a stream channel is not in channels", () => {
    const { nodes, channels, inputChannels, outputChannels } =
      setupValidGraph();

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
        streamChannels: "nonexistent" as unknown as keyof TestChannels,
      })
    ).toThrow("Output channel 'nonexistent' not in channels");
  });

  it("should throw when an interruptAfterNode is not in nodes", () => {
    const { nodes, channels, inputChannels, outputChannels } =
      setupValidGraph();

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
        interruptAfterNodes: [
          "nonexistentNode",
        ] as unknown as (keyof TestNodes)[],
      })
    ).toThrow("Node nonexistentNode not in nodes");
  });

  it("should throw when an interruptBeforeNode is not in nodes", () => {
    const { nodes, channels, inputChannels, outputChannels } =
      setupValidGraph();

    // Act & Assert: Should throw specific error
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
        interruptBeforeNodes: [
          "nonexistentNode",
        ] as unknown as (keyof TestNodes)[],
      })
    ).toThrow("Node nonexistentNode not in nodes");
  });

  it("should accept '*' as a valid value for interruptAfterNodes", () => {
    const { nodes, channels, inputChannels, outputChannels } =
      setupValidGraph();

    // Act & Assert: Should not throw
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
        interruptAfterNodes: "*" as unknown as All,
      })
    ).not.toThrow();
  });

  it("should accept '*' as a valid value for interruptBeforeNodes", () => {
    const { nodes, channels, inputChannels, outputChannels } =
      setupValidGraph();

    // Act & Assert: Should not throw
    expect(() =>
      validateGraph({
        nodes,
        channels,
        inputChannels,
        outputChannels,
        interruptBeforeNodes: "*" as unknown as All,
      })
    ).not.toThrow();
  });
});

describe("validateKeys", () => {
  it("should validate keys that exist in channels", () => {
    const { channels } = setupValidGraph();

    // Act & Assert: Should not throw for valid keys
    expect(() => validateKeys("input", channels)).not.toThrow();
    expect(() => validateKeys(["input", "output"], channels)).not.toThrow();
  });

  it("should throw when a single key doesn't exist in channels", () => {
    const { channels } = setupValidGraph();

    // Act & Assert: Should throw with specific message
    expect(() =>
      validateKeys("nonexistent" as unknown as keyof TestChannels, channels)
    ).toThrow("Key nonexistent not found in channels");
  });

  it("should throw when any key in an array doesn't exist in channels", () => {
    const { channels } = setupValidGraph();

    // Act & Assert: Should throw with specific message
    expect(() =>
      validateKeys(
        ["input", "nonexistent"] as unknown as (keyof TestChannels)[],
        channels
      )
    ).toThrow("Key nonexistent not found in channels");
  });
});
