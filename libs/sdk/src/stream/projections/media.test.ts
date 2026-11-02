import { describe, expect, it, vi } from "vitest";
import type { Channel, Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { imagesProjection } from "./media.js";

function makeRootBus() {
  const listeners = new Set<(event: Event) => void>();
  const bus: RootEventBus = {
    channels: ["messages"] as readonly Channel[],
    subscribe: vi.fn((listener: (event: Event) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    bus,
    emit(event: Event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function messagesEvent(namespace: string[], data: unknown): Event {
  return {
    type: "event",
    method: "messages",
    params: {
      namespace,
      data,
    },
  } as Event;
}

describe("media projections", () => {
  it("root media projections ignore first-level root-pump messages", async () => {
    const { bus, emit } = makeRootBus();
    const store = new StreamStore(imagesProjection([]).initial);
    const projection = imagesProjection([]);

    const runtime = projection.open({
      thread: {} as ThreadStream,
      store,
      rootBus: bus,
    });

    const namespace = ["visualizer_0:run"];
    emit(messagesEvent(namespace, { event: "message-start", id: "msg" }));
    emit(
      messagesEvent(namespace, {
        event: "content-block-start",
        index: 0,
        content: {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("png-bytes").toString("base64"),
        },
      })
    );
    emit(messagesEvent(namespace, { event: "message-finish" }));

    expect(store.getSnapshot()).toHaveLength(0);

    await runtime.dispose();
  });

  it("first-level scoped media projections use subscription replay", async () => {
    const { bus } = makeRootBus();
    const projection = imagesProjection(["visualizer_0:run"]);
    const store = new StreamStore(projection.initial);
    const events = [
      messagesEvent(["visualizer_0:run"], {
        event: "content-block-finish",
        index: 0,
        content: {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("right").toString("base64"),
        },
      }),
    ];
    const thread = {
      subscribe: vi.fn(async () => {
        const subscription = {
          isPaused: false,
          async unsubscribe() {},
          async waitForResume() {},
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
        };
        return subscription;
      }),
    } as unknown as ThreadStream;

    const runtime = projection.open({
      thread,
      store,
      rootBus: bus,
    });

    await vi.waitFor(() => expect(store.getSnapshot()).toHaveLength(1));

    const images = store.getSnapshot();
    await expect(images[0]!.blob).resolves.toMatchObject({
      size: "right".length,
      type: "image/png",
    });

    await runtime.dispose();
  });
});
