import { describe, expect, it } from "@jest/globals";
import { RunnableConfig, RunnablePassthrough } from "@langchain/core/runnables";
import { ChannelWrite, PASSTHROUGH } from "../pregel/write.js";

describe("ChannelWrite", () => {
  describe("_getWriteValues", () => {
    it("should return the expect object", async () => {
      // set up test
      const channelWrite = new ChannelWrite([
        {
          channel: "someChannel1",
          value: 1,
          skipNone: false,
        },
        {
          channel: "someChannel2",
          value: PASSTHROUGH,
          skipNone: false,
          mapper: new RunnablePassthrough(),
        },
        {
          channel: "someChannel3",
          value: null,
          skipNone: true,
        },
        {
          channel: "someChannel4",
          value: PASSTHROUGH,
          skipNone: false,
        },
      ]);

      const input = 2;
      const config: RunnableConfig = {};

      // call method / assertions
      const writeValues = await channelWrite._getWriteValues(input, config);

      const expectedWriteValues = {
        someChannel1: 1,
        someChannel2: 2, // value is set to input value since PASSTHROUGH value was specified (with mapper)
        // someChannel3 should be filtered out
        someChannel4: 2, // value is set to input value since PASSTHROUGH value was specified
      };
      expect(writeValues).toEqual(expectedWriteValues);
    });
  });
});
