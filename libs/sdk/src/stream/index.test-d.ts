import { expectTypeOf, test } from "vitest";

import type * as Root from "../index.js";
import type * as Stream from "./index.js";
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
});

test("the root entry exports the ui constants' types", () => {
  expectTypeOf<typeof Root.NAMESPACE_SEPARATOR>().toEqualTypeOf<
    typeof NAMESPACE_SEPARATOR
  >();
  expectTypeOf<typeof Root.DEFAULT_MESSAGES_KEY>().toEqualTypeOf<
    typeof DEFAULT_MESSAGES_KEY
  >();
});
