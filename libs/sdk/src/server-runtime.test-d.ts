import type { ServerRuntime } from "@langchain/langgraph-sdk";
import { expectTypeOf, test } from "vitest";

test("public ServerRuntime defaults to unknown context", () => {
  type RunRuntime = Extract<
    ServerRuntime,
    { accessContext: "threads.create_run" }
  >;
  expectTypeOf<
    RunRuntime["executionRuntime"]["context"]
  >().toEqualTypeOf<unknown>();
});

test("accessContext narrows graph factory execution context", () => {
  const factory = (runtime: ServerRuntime<{ tenant: string }>) => {
    if (runtime.accessContext === "threads.create_run") {
      expectTypeOf(runtime.executionRuntime.context).toEqualTypeOf<
        { tenant: string } | undefined
      >();
    } else {
      expectTypeOf(runtime.accessContext).toEqualTypeOf<
        "assistants.read" | "threads.read" | "threads.update"
      >();
      expectTypeOf(runtime.executionRuntime).toEqualTypeOf<null>();
    }
  };

  factory({
    accessContext: "threads.create_run",
    executionRuntime: { context: undefined },
  });
  factory({ accessContext: "threads.read", executionRuntime: null });
  // @ts-expect-error Runs must have an execution runtime.
  factory({ accessContext: "threads.create_run", executionRuntime: null });
  // @ts-expect-error Inspection must not have an execution runtime.
  factory({
    accessContext: "assistants.read",
    executionRuntime: { context: undefined },
  });
});
