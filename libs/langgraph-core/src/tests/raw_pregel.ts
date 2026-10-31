/**
 * Build graphs directly on the Pregel engine, for tests of engine behavior.
 *
 * LangGraph does not expose this: applications build graphs with `StateGraph`
 * or `entrypoint`. Tests use it to set up channels, triggers and writes that
 * those APIs do not produce on their own.
 */
import {
  _coerceToRunnable,
  Runnable,
  RunnableFunc,
  RunnableLike,
} from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { Pregel } from "../pregel/index.js";
import { PregelNode } from "../pregel/read.js";
import type { PregelInputType, PregelOutputType } from "../pregel/types.js";
import { ChannelWrite, ChannelWriteEntry, PASSTHROUGH } from "../pregel/write.js";
import type { StrRecord } from "../pregel/algo.js";

type WriteValue = Runnable | RunnableFunc<unknown, unknown> | unknown;

/**
 * Options for subscribing to multiple channels.
 */
export type MultipleChannelSubscriptionOptions = {
  /**
   * Optional tags to associate with the subscription.
   */
  tags?: string[];
};

/**
 * Options for subscribing to a single channel.
 */
export type SingleChannelSubscriptionOptions = {
  /**
   * When specified, the channel mapping will be an object with this key pointing
   * to the array of channels to subscribe to. Otherwise, the channel mapping
   * will be an array of channels.
   */
  key?: string;
  /**
   * Optional tags to associate with the subscription.
   */
  tags?: string[];
};

/**
 * Utility class for working with channels in the Pregel system.
 * Provides static methods for subscribing to channels and writing to them.
 *
 * Channels are the communication pathways between nodes in a Pregel graph.
 * They enable message passing and state updates between different parts of the graph.
 */
export class Channel {
  /**
   * Creates a PregelNode that subscribes to a single channel.
   * This is used to define how nodes receive input from channels.
   *
   * @example
   * ```typescript
   * // Subscribe to a single channel
   * const node = Channel.subscribeTo("messages");
   *
   * // Subscribe to multiple channels
   * const node = Channel.subscribeTo(["messages", "state"]);
   *
   * // Subscribe with a custom key
   * const node = Channel.subscribeTo("messages", { key: "chat" });
   * ```
   *
   * @param channel Single channel name to subscribe to
   * @param options Subscription options
   * @returns A PregelNode configured to receive from the specified channels
   * @throws {Error} If a key is specified when subscribing to multiple channels
   */
  static subscribeTo(
    channel: string,
    options?: SingleChannelSubscriptionOptions
  ): PregelNode;

  /**
   * Creates a PregelNode that subscribes to multiple channels.
   * This is used to define how nodes receive input from channels.
   *
   * @example
   * ```typescript
   * // Subscribe to a single channel
   * const node = Channel.subscribeTo("messages");
   *
   * // Subscribe to multiple channels
   * const node = Channel.subscribeTo(["messages", "state"]);
   *
   * // Subscribe with a custom key
   * const node = Channel.subscribeTo("messages", { key: "chat" });
   * ```
   *
   * @param channels Single channel name to subscribe to
   * @param options Subscription options
   * @returns A PregelNode configured to receive from the specified channels
   * @throws {Error} If a key is specified when subscribing to multiple channels
   */
  static subscribeTo(
    channels: string[],
    options?: MultipleChannelSubscriptionOptions
  ): PregelNode;

  static subscribeTo(
    channels: string | string[],
    options?:
      | SingleChannelSubscriptionOptions
      | MultipleChannelSubscriptionOptions
  ): PregelNode {
    const { key, tags } = {
      key: undefined,
      tags: undefined,
      ...(options ?? {}),
    };
    if (Array.isArray(channels) && key !== undefined) {
      throw new Error(
        "Can't specify a key when subscribing to multiple channels"
      );
    }

    let channelMappingOrArray: string[] | Record<string, string>;

    if (typeof channels === "string") {
      if (key) {
        channelMappingOrArray = { [key]: channels };
      } else {
        channelMappingOrArray = [channels];
      }
    } else {
      channelMappingOrArray = Object.fromEntries(
        channels.map((chan) => [chan, chan])
      );
    }

    const triggers: string[] = Array.isArray(channels) ? channels : [channels];

    return new PregelNode({
      channels: channelMappingOrArray,
      triggers,
      tags,
    });
  }

  /**
   * Creates a ChannelWrite that specifies how to write values to channels.
   * This is used to define how nodes send output to channels.
   *
   * @example
   * ```typescript
   * // Write to multiple channels
   * const write = Channel.writeTo(["output", "state"]);
   *
   * // Write with specific values
   * const write = Channel.writeTo(["output"], {
   *   state: "completed",
   *   result: calculateResult()
   * });
   *
   * // Write with a transformation function
   * const write = Channel.writeTo(["output"], {
   *   result: (x) => processResult(x)
   * });
   * ```
   *
   * @param channels - Array of channel names to write to
   * @param writes - Optional map of channel names to values or transformations
   * @returns A ChannelWrite object that can be used to write to the specified channels
   */
  static writeTo(
    channels: string[],
    writes?: Record<string, WriteValue>
  ): ChannelWrite {
    const channelWriteEntries: Array<ChannelWriteEntry> = [];

    for (const channel of channels) {
      channelWriteEntries.push({
        channel,
        value: PASSTHROUGH,
        skipNone: false,
      });
    }

    for (const [key, value] of Object.entries(writes ?? {})) {
      if (Runnable.isRunnable(value) || typeof value === "function") {
        channelWriteEntries.push({
          channel: key,
          value: PASSTHROUGH,
          skipNone: true,
          mapper: _coerceToRunnable(value as RunnableLike),
        });
      } else {
        channelWriteEntries.push({
          channel: key,
          value,
          skipNone: false,
        });
      }
    }

    return new ChannelWrite(channelWriteEntries);
  }
}

/**
 * A `Pregel` built from hand-written nodes and channels.
 */
export class RawPregel<
  Nodes extends StrRecord<string, PregelNode>,
  Channels extends StrRecord<string, BaseChannel>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextType extends Record<string, any> = StrRecord<string, any>,
  InputType = PregelInputType,
  OutputType = PregelOutputType,
> extends Pregel<Nodes, Channels, ContextType, InputType, OutputType> {}
