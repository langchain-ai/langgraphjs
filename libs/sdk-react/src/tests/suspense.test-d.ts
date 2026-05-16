/**
 * Type tests for the v1 slim `useSuspenseStream`.
 *
 * The v1 surface:
 * - Adds `isStreaming: boolean` (renames legacy `isLoading`).
 * - Drops `isLoading`, `isThreadLoading`, `hydrationPromise`.
 * - Keeps `messages`, `submit`, `stop`, `respond`, `getThread`, …
 * - Drops `switchThread`, `SuspenseCache`, `createSuspenseCache`,
 *   `invalidateSuspenseCache`, and the `suspenseCache` option (see
 *   `plan-roadmap.md` / `_useSuspenseStream.md`).
 *
 * These tests are type-only; Vitest compiles them but does not run
 * them.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, test, expectTypeOf } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import type { Message } from "@langchain/langgraph-sdk";

import { useSuspenseStream } from "../index.js";
import type { UseSuspenseStreamReturn } from "../suspense-stream.js";

describe("useSuspenseStream: return-type shape", () => {
  test("isStreaming is boolean", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });
    expectTypeOf(stream.isStreaming).toEqualTypeOf<boolean>();
  });

  test("isLoading / isThreadLoading / hydrationPromise are dropped", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });
    expectTypeOf(stream).not.toHaveProperty("isLoading");
    expectTypeOf(stream).not.toHaveProperty("isThreadLoading");
    expectTypeOf(stream).not.toHaveProperty("hydrationPromise");
  });

  test("messages is BaseMessage[]", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });
    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
  });

  test("submit / stop / getThread are callable", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });
    expectTypeOf(stream.submit).toBeFunction();
    expectTypeOf(stream.stop).toBeFunction();
    expectTypeOf(stream.getThread).toBeFunction();
  });

  test("switchThread has been removed", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });
    expectTypeOf(stream).not.toHaveProperty("switchThread");
  });
});

describe("UseSuspenseStreamReturn is assignable from useSuspenseStream", () => {
  test("explicit generic round-trip", () => {
    const stream = useSuspenseStream<{ messages: Message[] }>({
      assistantId: "agent",
    });
    expectTypeOf(stream).toMatchTypeOf<
      UseSuspenseStreamReturn<{ messages: Message[] }>
    >();
  });
});
