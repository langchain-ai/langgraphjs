import type { Client, StreamProtocol } from "@langchain/langgraph-sdk";
import type { StreamRuntime } from "./types.js";
import { LegacyStreamRuntime } from "./legacy.js";
import { ProtocolStreamRuntime } from "./protocol/runtime.js";

export function createStreamRuntime<
  StateType extends Record<string, unknown>,
  UpdateType,
  ConfigurableType extends Record<string, unknown>,
  CustomType,
>(
  client: Client<StateType, UpdateType, CustomType>,
  streamProtocol?: StreamProtocol,
  protocolFetch?: typeof fetch,
  protocolWebSocketFactory?: (url: string) => WebSocket,
): {
  runtime: StreamRuntime<StateType, UpdateType, ConfigurableType, CustomType>;
  protocolRuntime: ProtocolStreamRuntime<
    StateType,
    UpdateType,
    ConfigurableType,
    CustomType
  >;
} {
  const legacyRuntime = new LegacyStreamRuntime<
    StateType,
    UpdateType,
    ConfigurableType,
    CustomType
  >(client);
  const protocolRuntime = new ProtocolStreamRuntime<
    StateType,
    UpdateType,
    ConfigurableType,
    CustomType
  >(client, streamProtocol, {
    protocolFetch,
    protocolWebSocket: protocolWebSocketFactory,
  });

  if (streamProtocol === "v2-sse" || streamProtocol === "v2-websocket") {
    return {
      runtime: {
        submit: async (args) =>
          protocolRuntime.canSubmit({
            streamMode: args.streamMode,
            submitOptions: args.submitOptions,
          })
            ? await protocolRuntime.submit(args)
            : await legacyRuntime.submit(args),
        join: async (args) => await protocolRuntime.join(args),
      },
      protocolRuntime,
    };
  }

  return {
    runtime: legacyRuntime,
    protocolRuntime,
  };
}

export type { StreamRuntime } from "./types.js";
