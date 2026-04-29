import { signal, type Signal } from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { Message } from "@langchain/langgraph-sdk";
import type { AssembledToolCall } from "@langchain/langgraph-sdk/stream";
import { describe, expectTypeOf, test } from "vitest";

import {
  injectMessageMetadata,
  injectSubmissionQueue,
  useStream,
  StreamService,
} from "../index.js";

interface BasicState {
  messages: Message[];
}

describe("useStream return shape", () => {
  test("root projections are Angular signals", () => {
    const stream = useStream<BasicState>({ assistantId: "agent" });

    expectTypeOf(stream.values).toExtend<Signal<BasicState>>();
    expectTypeOf(stream.messages).toExtend<Signal<BaseMessage[]>>();
    expectTypeOf(stream.toolCalls).toExtend<Signal<AssembledToolCall[]>>();
    expectTypeOf(stream.isLoading()).toEqualTypeOf<boolean>();
    expectTypeOf(stream.threadId()).toEqualTypeOf<string | null>();
  });

  test("imperatives remain plain methods", () => {
    const stream = useStream<BasicState>({ assistantId: "agent" });

    expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.respond("ok")).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
  });

  test("submit accepts BaseMessage instances", () => {
    const stream = useStream<BasicState>({ assistantId: "agent" });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [new HumanMessage("Hello")] },
      undefined
    );
  });

  test("threadId accepts Angular signals", () => {
    const threadId = signal<string | null>(null);
    const stream = useStream<BasicState>({ assistantId: "agent", threadId });

    expectTypeOf(stream.threadId()).toEqualTypeOf<string | null>();
  });
});

describe("companion injectors", () => {
  test("queue is exposed through injectSubmissionQueue", () => {
    const stream = useStream<BasicState>({ assistantId: "agent" });
    const queue = injectSubmissionQueue(stream);

    expectTypeOf(queue.entries).toExtend<Signal<readonly unknown[]>>();
    expectTypeOf(queue.size()).toEqualTypeOf<number>();
    expectTypeOf(queue.cancel("id")).toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(queue.clear()).toEqualTypeOf<Promise<void>>();
  });

  test("message metadata is exposed through injectMessageMetadata", () => {
    const stream = useStream<BasicState>({ assistantId: "agent" });
    const metadata = injectMessageMetadata(stream, () => stream.messages()[0]?.id);

    if (metadata()) {
      expectTypeOf(metadata()!.parentCheckpointId).toEqualTypeOf<
        string | undefined
      >();
    }
  });
});

describe("StreamService mirrors the stream surface", () => {
  test("service exposes signals and imperatives", () => {
    const svc = null as unknown as StreamService<BasicState>;

    expectTypeOf(svc.values).toExtend<Signal<BasicState>>();
    expectTypeOf(svc.messages).toExtend<Signal<BaseMessage[]>>();
    expectTypeOf(svc.isLoading()).toEqualTypeOf<boolean>();
    expectTypeOf(svc.submit(null)).toEqualTypeOf<Promise<void>>();
    expectTypeOf(svc.getThread()).not.toBeNever();
  });
});
