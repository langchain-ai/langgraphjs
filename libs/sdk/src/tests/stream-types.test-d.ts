import { describe, test } from "vitest";
import type { Message } from "../types.messages.js";
import type { BagTemplate } from "../types.template.js";
import type { UseStream } from "../react/types.js";
import type { ResolveStreamInterface } from "../ui/stream/index.js";

describe("UseStream backward compatibility", () => {
  test("ResolveStreamInterface for plain state type is assignable to UseStream", () => {
    type GeneratorState = {
      messages: Message[];
    };

    // This assignment must compile. If BaseStream is missing properties from UseStream,
    // TypeScript will produce an error here.
    // This is the exact scenario from the bug report.
    const resolved: ResolveStreamInterface<GeneratorState, BagTemplate> =
      {} as never;
    const _stream: UseStream<GeneratorState, BagTemplate> = resolved;
    void _stream;
  });

  test("ResolveStreamInterface for Record<string, unknown> is assignable to UseStream", () => {
    const resolved: ResolveStreamInterface<
      Record<string, unknown>,
      BagTemplate
    > = {} as never;
    const _stream: UseStream<Record<string, unknown>, BagTemplate> = resolved;
    void _stream;
  });
});
