import { describe, expect, it } from "vitest";
import { PregelNode } from "../pregel/read.js";
import { GraphValidationError, validateGraph } from "../pregel/validate.js";
import { LastValue } from "../channels/last_value.js";

describe("validateGraph", () => {
  it("should throw an error if a node is named __interrupt__", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      __interrupt__: new PregelNode({
        channels: [""],
        triggers: [],
      }),
    };
    const channels = {
      "": new LastValue(),
    };

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels,
        inputChannels: "",
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      });
    }).toThrow(GraphValidationError);
  });

  it("should throw an error if a node is not the correct type", () => {
    // set up test
    class PregelNodeSubclass extends PregelNode {}

    const nodes: Record<string, PregelNode> = {
      channelName: new PregelNodeSubclass({
        channels: [""],
        triggers: [],
      }),
    };

    const channels = {
      "": new LastValue(),
    };

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels,
        inputChannels: "",
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      });
    }).toThrow(GraphValidationError);
  });

  it("should throw an error if input channel is not subscribed to by any node", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      channelName1: new PregelNode({
        channels: [""],
        triggers: ["channelName2"],
      }),
    };

    const channels = {
      "": new LastValue(),
    };

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels,
        // @ts-expect-error - testing invalid input
        inputChannels: "channelName3",
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      });
    }).toThrow(GraphValidationError);
  });

  it("should throw an error if none of the input channels are subscribed to by any node", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      channelName1: new PregelNode({
        channels: [""],
        triggers: ["channelName2"],
      }),
    };

    const channels = {
      "": new LastValue(),
    };

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels,
        // @ts-expect-error - testing invalid input
        inputChannels: ["channelName3", "channelName4", "channelName5"],
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      });
    }).toThrow(GraphValidationError);
  });

  it("should throw an error if 'interrupt after' nodes not in nodes map", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      channelName1: new PregelNode({
        channels: [""],
        triggers: ["channelName2"],
      }),
    };
    const channels = {
      "": new LastValue(),
    };

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels,
        inputChannels: [""],
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: ["channelName3"],
        interruptBeforeNodes: [],
      });
    }).toThrow(GraphValidationError);
  });

  it("should throw an error if 'interrupt after' nodes not in nodes map", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      channelName1: new PregelNode({
        channels: [""],
        triggers: ["channelName2"],
      }),
    };
    const channels = {
      "": new LastValue(),
    };

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels,
        inputChannels: [""],
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: ["channelName3"],
      });
    }).toThrow(GraphValidationError);
  });

  it("should thrown on missing channels", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      channelName1: new PregelNode({
        channels: [""],
        triggers: ["channelName2"],
      }),
    };

    const channels1 = {
      "": new LastValue(),
      channelName2: new LastValue(),
    };

    // call method / assertions
    expect(() =>
      validateGraph({
        nodes,
        channels: channels1,
        inputChannels: "channelName2",
        // @ts-expect-error - testing invalid input
        outputChannels: "channelName3",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      })
    ).toThrow(GraphValidationError);

    // call method / assertions
    expect(() =>
      validateGraph({
        nodes,
        channels: channels1,
        // @ts-expect-error - testing invalid input
        inputChannels: "channelName3",
        outputChannels: "channelName2",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      })
    ).toThrow(GraphValidationError);

    // call method / assertions
    expect(() =>
      validateGraph({
        nodes,
        channels: channels1,
        inputChannels: "channelName2",
        outputChannels: "",
        // @ts-expect-error - testing invalid input
        streamChannels: "channelName4",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
      })
    ).toThrow(GraphValidationError);
  });
});
