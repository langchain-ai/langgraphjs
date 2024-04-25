import { describe, expect, it } from "@jest/globals";
import { readChannel, readChannels } from "../pregel/io.js";
import { BaseChannel, EmptyChannelError } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";

describe("readChannel", () => {
  it("should read a channel successfully", () => {
    // set up test
    const channel = new LastValue<number>();
    channel.update([3]);

    const channels: Record<string, BaseChannel> = {
      someChannelName: channel,
    };

    // call method / assertions
    const newChannel = readChannel(channels, "someChannelName");
    expect(newChannel).toBe(3);
  });

  it("should return EmptyChannelError when the channel is empty", () => {
    // set up test
    const channels: Record<string, BaseChannel> = {
      someChannelName: new LastValue<number>(),
    };

    // call method / assertions
    const error = readChannel(channels, "someChannelName", true, true);
    expect(error).toBeInstanceOf(EmptyChannelError);
  });

  it("should return null when the channel is empty", () => {
    // set up test
    const channels: Record<string, BaseChannel> = {
      someChannelName: new LastValue<number>(),
    };

    // call method / assertions
    const error = readChannel(channels, "someChannelName", true, false);
    expect(error).toBeNull();
  });

  it("should throw an error when the channel is empty", () => {
    // set up test
    const channels: Record<string, BaseChannel> = {
      someChannelName: new LastValue<number>(),
    };

    // call method / assertions
    try {
      readChannel(channels, "someChannelName", false, false);
    } catch (e) {
      expect(e).toBeInstanceOf(EmptyChannelError);
    }
  });
});

describe("readChannels", () => {
  it("should return a single channel value", () => {
    // set up test
    const channel = new LastValue<number>();
    channel.update([3]);

    const channels: Record<string, BaseChannel> = {
      someChannelName: channel,
    };

    // call method / assertions
    const newChannel = readChannels(channels, "someChannelName");
    expect(newChannel).toBe(3);
  });

  it("should return multiple channel values", () => {
    // set up test
    const channel1 = new LastValue<number>();
    const channel2 = new LastValue<number>();
    const emptyChannel = new LastValue<number>();
    channel1.update([3]);
    channel2.update([4]);

    const channels: Record<string, BaseChannel> = {
      someChannelName1: channel1,
      someChannelName2: channel2,
      someChannelName3: emptyChannel,
    };

    // call method / assertions
    const channelValues = readChannels(channels, [
      "someChannelName1",
      "someChannelName2",
      "someChannelName3",
    ]);
    expect(channelValues).toEqual({ someChannelName1: 3, someChannelName2: 4 });
  });

  it("should return multiple channel values including null for empty channels", () => {
    // set up test
    const channel1 = new LastValue<number>();
    const channel2 = new LastValue<number>();
    const emptyChannel = new LastValue<number>();
    channel1.update([3]);
    channel2.update([4]);

    const channels: Record<string, BaseChannel> = {
      someChannelName1: channel1,
      someChannelName2: channel2,
      someChannelName3: emptyChannel,
    };

    // call method / assertions
    const channelValues = readChannels(
      channels,
      ["someChannelName1", "someChannelName2", "someChannelName3"],
      false
    );
    expect(channelValues).toEqual({
      someChannelName1: 3,
      someChannelName2: 4,
      someChannelName3: null,
    });
  });
});
