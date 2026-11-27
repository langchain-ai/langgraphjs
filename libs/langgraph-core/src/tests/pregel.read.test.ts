import { describe, expect, it, vi } from "vitest";
import {
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";
import { PregelNode } from "../pregel/read.js";
import { ChannelWrite } from "../pregel/write.js";
import { CONFIG_KEY_SEND } from "../constants.js";

describe("PregelNode", () => {
  describe("getWriters", () => {
    it("should return the expected array of writers", () => {
      // set up test
      const pregelNode = new PregelNode({
        channels: ["foo"],
        triggers: ["bar"],
        writers: [
          new ChannelWrite([
            { channel: "channel1", value: 1, skipNone: false },
            { channel: "channel2", value: 2, skipNone: false },
          ]),
          new ChannelWrite([
            { channel: "channel3", value: 3, skipNone: false },
            { channel: "channel4", value: 4, skipNone: false },
          ]),
        ],
      });

      // call method / assertions
      const newWriters = pregelNode.getWriters();
      expect(newWriters.length).toBe(1);
      expect((newWriters[0] as ChannelWrite).writes.length).toBe(4);
      // TODO: need to assert individual writes
    });
  });

  describe("getNode", () => {
    it("should return undefined if bound is default and there are no writers", () => {
      // set up test
      const pregelNode = new PregelNode({
        channels: ["foo"],
        triggers: ["bar"],
        writers: [],
        // bound is set to default
      });

      // call method / assertions
      expect(pregelNode.getNode()).toBeUndefined();
    });

    it("should return the only writer if there is only one writer", () => {
      const channelWrite = new ChannelWrite([
        { channel: "channel1", value: 1, skipNone: false },
      ]);
      const pregelNode = new PregelNode({
        channels: ["foo"],
        triggers: ["bar"],
        writers: [channelWrite],
        // bound is set to default
      });

      // call method / assertions
      expect(pregelNode.getNode()).toEqual(channelWrite);
    });

    it("should return a RunnableSequence of writers if there are multiple writers", () => {
      const channelWrite1 = new ChannelWrite([
        { channel: "channel1", value: 1, skipNone: false },
      ]);
      const channelWrite2 = new ChannelWrite([
        { channel: "channel2", value: 2, skipNone: false },
      ]);
      const pregelNode = new PregelNode({
        channels: ["foo"],
        triggers: ["bar"],
        writers: [channelWrite1, channelWrite2, new RunnablePassthrough()],
        // bound is set to default
      });

      // call method / assertions
      const runnableSequence = pregelNode.getNode() as RunnableSequence;
      expect(runnableSequence.steps).toEqual([
        channelWrite1,
        channelWrite2,
        new RunnablePassthrough(),
      ]);
    });

    it("should run the bound and all writers if there are multiple writers", async () => {
      const channelWrite1 = new ChannelWrite([
        { channel: "channel1", value: 1, skipNone: false },
      ]);
      const channelWrite2 = new ChannelWrite([
        { channel: "channel2", value: 2, skipNone: false },
      ]);
      const pregelNode = new PregelNode<string, string>({
        channels: ["foo"],
        triggers: ["bar"],
        writers: [channelWrite1, channelWrite2, new RunnablePassthrough<string>()],
        bound: new RunnablePassthrough<string>(),
      });

      // call method / assertions
      const send = vi.fn();
      expect(
        await pregelNode.getNode()!.invoke("input", {
          configurable: { [CONFIG_KEY_SEND]: send },
        })
      ).toBe("input");
      expect(send.mock.calls).toEqual([
        [[["channel1", 1]]],
        [[["channel2", 2]]],
      ]);
    });

    it("should return the custom bound", () => {
      const pregelNode = new PregelNode({
        channels: ["foo"],
        triggers: ["bar"],
        writers: [],
        bound: new RunnablePassthrough(),
      });

      // call method / assertions
      expect(pregelNode.getNode()).toEqual(new RunnablePassthrough());
    });
  });
});
