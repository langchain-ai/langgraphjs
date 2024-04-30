import { describe, expect, it } from "@jest/globals";
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

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels: {},
        inputChannels: "",
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
        defaultChannelFactory: () => new LastValue(),
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

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels: {},
        inputChannels: "",
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
        defaultChannelFactory: () => new LastValue(),
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

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels: {},
        inputChannels: "channelName3",
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
        defaultChannelFactory: () => new LastValue(),
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

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels: {},
        inputChannels: ["channelName3", "channelName4", "channelName5"],
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: [],
        defaultChannelFactory: () => new LastValue(),
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

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels: {},
        inputChannels: ["channelName2"],
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: ["channelName3"],
        interruptBeforeNodes: [],
        defaultChannelFactory: () => new LastValue(),
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

    // call method / assertions
    expect(() => {
      validateGraph({
        nodes,
        channels: {},
        inputChannels: ["channelName2"],
        outputChannels: "",
        streamChannels: "",
        interruptAfterNodes: [],
        interruptBeforeNodes: ["channelName3"],
        defaultChannelFactory: () => new LastValue(),
      });
    }).toThrow(GraphValidationError);
  });

  it("should have the side effect of updating the channels record", () => {
    // set up test
    const nodes: Record<string, PregelNode> = {
      channelName1: new PregelNode({
        channels: [""],
        triggers: ["channelName2"],
      }),
    };

    const channels1 = {};
    const channels2 = {};

    // call method / assertions
    validateGraph({
      nodes,
      channels: channels1,
      inputChannels: "channelName2",
      outputChannels: "channelName3",
      streamChannels: "channelName4",
      interruptAfterNodes: [],
      interruptBeforeNodes: [],
      defaultChannelFactory: () => new LastValue(),
    });

    const expectedChannels1 = {
      channelName2: new LastValue(),
      channelName3: new LastValue(),
      channelName4: new LastValue(),
    };

    expect(channels1).toEqual(expectedChannels1);

    validateGraph({
      nodes,
      channels: channels2,
      inputChannels: ["channelName2"],
      outputChannels: ["channelName3"],
      streamChannels: ["channelName4"],
      interruptAfterNodes: [],
      interruptBeforeNodes: [],
      defaultChannelFactory: () => new LastValue(),
    });

    const expectedChannels2 = {
      channelName2: new LastValue(),
      channelName3: new LastValue(),
      channelName4: new LastValue(),
    };

    expect(channels2).toEqual(expectedChannels2);
  });
});
