import { expectTypeOf, test } from "vitest";

import type {
  EndStreamEvent,
  LifecycleStreamEvent,
  TypedAsyncGenerator,
} from "./types.stream.js";

type StreamPart<Stream> =
  Stream extends AsyncGenerator<infer Part> ? Part : never;

test("a run stream can end with an end event", () => {
  expectTypeOf<EndStreamEvent>().toMatchTypeOf<
    StreamPart<TypedAsyncGenerator<"values">>
  >();
  expectTypeOf<EndStreamEvent>().toMatchTypeOf<
    StreamPart<TypedAsyncGenerator<"values", true>>
  >();
  expectTypeOf<EndStreamEvent["data"]>().toBeNullable();
});

test("a run stream that asks for lifecycle has lifecycle events", () => {
  expectTypeOf<LifecycleStreamEvent>().toMatchTypeOf<
    StreamPart<TypedAsyncGenerator<"lifecycle">>
  >();
  expectTypeOf<LifecycleStreamEvent>().toMatchTypeOf<
    StreamPart<TypedAsyncGenerator<["values", "lifecycle"], true>>
  >();
  expectTypeOf<LifecycleStreamEvent>().not.toMatchTypeOf<
    StreamPart<TypedAsyncGenerator<"values">>
  >();
});
