import { describe, test, expectTypeOf } from "vitest";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import type { BaseStream, ResolveStreamInterface } from "../ui/stream/index.js";
import type {
  SubmitOptions,
  CustomSubmitOptions,
  RunCallbackMeta,
} from "../ui/types.js";

describe("ResolveStreamInterface resolves plain state types to BaseStream", () => {
  test("plain state type resolves to BaseStream", () => {
    type GeneratorState = {
      messages: Message[];
    };

    type Resolved = ResolveStreamInterface<GeneratorState, BagTemplate>;
    expectTypeOf<Resolved>().toExtend<BaseStream<GeneratorState>>();
  });

  test("Record<string, unknown> resolves to BaseStream", () => {
    type Resolved = ResolveStreamInterface<
      Record<string, unknown>,
      BagTemplate
    >;
    expectTypeOf<Resolved>().toExtend<BaseStream<Record<string, unknown>>>();
  });
});

describe("SubmitOptions has onError callback", () => {
  test("SubmitOptions includes onError", () => {
    type Options = SubmitOptions<{ messages: Message[] }>;

    expectTypeOf<Options>().toHaveProperty("onError");
    type OnErrorType = Options["onError"];
    expectTypeOf<
      (error: unknown, run: RunCallbackMeta | undefined) => void
    >().toExtend<NonNullable<OnErrorType>>();
  });

  test("CustomSubmitOptions includes onError", () => {
    type Options = CustomSubmitOptions<{ messages: Message[] }>;

    expectTypeOf<Options>().toHaveProperty("onError");
    type OnErrorType = Options["onError"];
    expectTypeOf<
      (error: unknown, run: RunCallbackMeta | undefined) => void
    >().toExtend<NonNullable<OnErrorType>>();
  });
});
