import { expectTypeOf, test } from "vitest";

import type { EndStreamEvent, TypedAsyncGenerator } from "./types.stream.js";

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
