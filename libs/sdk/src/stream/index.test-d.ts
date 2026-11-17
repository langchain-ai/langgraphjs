import { expectTypeOf, test } from "vitest";

import type * as Root from "../index.js";
import type * as Ui from "../ui/index.js";
import type * as Stream from "./index.js";
import type { DefaultToolCall } from "../types.messages.js";
import type {
  DEFAULT_MESSAGES_KEY,
  NAMESPACE_SEPARATOR,
} from "../ui/constants.js";
import type {
  MessageMetadata,
  MessageMetadataMap,
} from "../ui/message-metadata-tracker.js";
import type { StoreListener, StreamStore } from "../ui/store.js";
import type {
  SubgraphByNodeMap,
  SubgraphDiscovery,
  SubgraphDiscoverySnapshot,
  SubgraphMap,
} from "../ui/subgraphs.js";
import type {
  AssembledToolCall,
  ToolCallStatus,
  parseToolOutput,
  parseToolPayload,
} from "../ui/tool-payload.js";

test("the stream entry exports the ui modules' types", () => {
  expectTypeOf<typeof Stream.StreamStore>().toEqualTypeOf<typeof StreamStore>();
  expectTypeOf<Stream.StoreListener>().toEqualTypeOf<StoreListener>();
  expectTypeOf<typeof Stream.NAMESPACE_SEPARATOR>().toEqualTypeOf<
    typeof NAMESPACE_SEPARATOR
  >();
  expectTypeOf<typeof Stream.DEFAULT_MESSAGES_KEY>().toEqualTypeOf<
    typeof DEFAULT_MESSAGES_KEY
  >();
  expectTypeOf<Stream.AssembledToolCall>().toEqualTypeOf<AssembledToolCall>();
  expectTypeOf<Stream.ToolCallStatus>().toEqualTypeOf<ToolCallStatus>();
  expectTypeOf<typeof Stream.parseToolPayload>().toEqualTypeOf<
    typeof parseToolPayload
  >();
  expectTypeOf<typeof Stream.parseToolOutput>().toEqualTypeOf<
    typeof parseToolOutput
  >();
  expectTypeOf<Stream.MessageMetadata>().toEqualTypeOf<MessageMetadata>();
  expectTypeOf<Stream.MessageMetadataMap>().toEqualTypeOf<MessageMetadataMap>();
  expectTypeOf<typeof Stream.SubgraphDiscovery>().toEqualTypeOf<
    typeof SubgraphDiscovery
  >();
  expectTypeOf<Stream.SubgraphDiscoverySnapshot>().toEqualTypeOf<SubgraphDiscoverySnapshot>();
  expectTypeOf<Stream.SubgraphMap>().toEqualTypeOf<SubgraphMap>();
  expectTypeOf<Stream.SubgraphByNodeMap>().toEqualTypeOf<SubgraphByNodeMap>();
});

type SearchTool = {
  name: "search";
  _call: (arg: { query: string }) => Promise<string>;
};
type SearchToolCall = AssembledToolCall<"search", { query: string }, string>;

test("InferToolCalls infers assembled tool calls from the stream entry only", () => {
  expectTypeOf<
    Stream.InferToolCalls<[SearchTool]>
  >().toEqualTypeOf<SearchToolCall>();
  expectTypeOf<
    Ui.InferAssembledToolCalls<[SearchTool]>
  >().toEqualTypeOf<SearchToolCall>();
  expectTypeOf<
    Stream.AssembledToolCallFromTool<SearchTool>
  >().toEqualTypeOf<SearchToolCall>();
  expectTypeOf<
    Ui.InferToolCalls<[SearchTool]>
  >().toEqualTypeOf<DefaultToolCall>();
});

test("the root entry exports the ui constants' types", () => {
  expectTypeOf<typeof Root.NAMESPACE_SEPARATOR>().toEqualTypeOf<
    typeof NAMESPACE_SEPARATOR
  >();
  expectTypeOf<typeof Root.DEFAULT_MESSAGES_KEY>().toEqualTypeOf<
    typeof DEFAULT_MESSAGES_KEY
  >();
});
