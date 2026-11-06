import type { Event } from "@langchain/protocol";
import { describe, expect, it, vi } from "vitest";

import { MediaAssembler, type AnyMediaHandle } from "./media.js";
import { eventOf } from "./test/utils.js";

describe("MediaAssembler", () => {
  it("preserves initial metadata on URL-sourced media without fetching it", async () => {
    const media: AnyMediaHandle[] = [];
    const fetch = vi.fn();
    const assembler = new MediaAssembler({ fetch, onMedia: (handle) => media.push(handle) });
    assembler.consume(
      eventOf("messages", { event: "message-start", id: "url-media" }) as Extract<
        Event,
        { method: "messages" }
      >
    );
    const blocks = [
      {
        type: "image",
        url: "https://example.com/image.png",
        mime_type: "image/png",
        width: 640,
        height: 480,
      },
      {
        type: "file",
        url: "https://example.com/report.pdf",
        mime_type: "application/pdf",
        filename: "report.pdf",
      },
      {
        type: "audio",
        url: "https://example.com/audio.wav",
        mime_type: "audio/wav",
        transcript: "Hello",
      },
    ];
    for (const [index, content] of blocks.entries()) {
      assembler.consume(
        eventOf("messages", { event: "content-block-start", index, content }) as Extract<
          Event,
          { method: "messages" }
        >
      );
    }
    assembler.consume(
      eventOf("messages", { event: "message-finish", reason: "stop" }) as Extract<
        Event,
        { method: "messages" }
      >
    );
    expect(media).toHaveLength(3);
    expect(media[0]).toMatchObject({ width: 640, height: 480, mimeType: "image/png" });
    expect(media[1]).toMatchObject({ filename: "report.pdf", mimeType: "application/pdf" });
    const audio = media[2];
    if (audio?.type !== "audio") throw new Error("Expected audio handle");
    await expect(audio.transcript).resolves.toBe("Hello");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("assembles audio bytes from protocol data deltas", async () => {
    const audio: Array<{
      mimeType?: string;
      transcript: Promise<string | undefined>;
      blob: Promise<Blob>;
    }> = [];
    const assembler = new MediaAssembler({
      onAudio: (clip) => audio.push(clip),
    });

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_audio" }, {
        namespace: ["narrator_0"],
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: {
            type: "audio",
            mimeType: "audio/pcm",
            data: "",
          },
        },
        { namespace: ["narrator_0"] }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "data-delta", data: "AAAA", encoding: "base64" },
        },
        { namespace: ["narrator_0"] }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: {
            type: "block-delta",
            fields: { type: "audio", transcript: "hello" },
          },
        },
        { namespace: ["narrator_0"] }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
        },
        { namespace: ["narrator_0"] }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(audio).toHaveLength(1);
    expect(audio[0]!.mimeType).toBe("audio/pcm");
    await expect(audio[0]!.transcript).resolves.toBe("hello");
    await expect(audio[0]!.blob).resolves.toMatchObject({
      type: "audio/pcm",
      size: 3,
    });
  });

  it("accepts camel-case mimeType on media content blocks", async () => {
    const images: Array<{ mimeType?: string; blob: Promise<Blob> }> = [];
    const assembler = new MediaAssembler({
      onImage: (image) => images.push(image),
    });

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_image" }, {
        namespace: ["visualizer_0"],
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
        { namespace: ["visualizer_0"] }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
        },
        { namespace: ["visualizer_0"] }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe("image/png");
    await expect(images[0]!.blob).resolves.toMatchObject({
      type: "image/png",
      size: 8,
    });
  });

  it("keeps multiple media blocks in one message as separate handles", async () => {
    const images: Array<{ blob: Promise<Blob> }> = [];
    const assembler = new MediaAssembler({
      onImage: (image) => images.push(image),
    });

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_images" }, {
        namespace: ["visualizer_0"],
      }) as Extract<Event, { method: "messages" }>
    );
    for (const index of [0, 1]) {
      assembler.consume(
        eventOf(
          "messages",
          {
            event: "content-block-start",
            index,
            content: {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
          { namespace: ["visualizer_0"] }
        ) as Extract<Event, { method: "messages" }>
      );
    }
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
        },
        { namespace: ["visualizer_0"] }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(images).toHaveLength(2);
    await expect(images[0]!.blob).resolves.toMatchObject({ size: 8 });
    await expect(images[1]!.blob).resolves.toMatchObject({ size: 8 });
  });

  it("assembles a handle from a terminal media block when the start was missed", async () => {
    const audio: Array<{ mimeType?: string; blob: Promise<Blob> }> = [];
    const assembler = new MediaAssembler({
      onAudio: (clip) => audio.push(clip),
    });

    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content: {
            type: "audio",
            mimeType: "audio/pcm",
            data: "AAAA",
          },
        },
        { namespace: ["narrator_0"] }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(audio).toHaveLength(1);
    expect(audio[0]!.mimeType).toBe("audio/pcm");
    await expect(audio[0]!.blob).resolves.toMatchObject({
      type: "audio/pcm",
      size: 3,
    });
  });

  it("creates a media handle from typed block-delta fields when the start was missed", async () => {
    const images: Array<{ mimeType?: string; blob: Promise<Blob> }> = [];
    const assembler = new MediaAssembler({
      onImage: (image) => images.push(image),
    });

    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: {
            type: "block-delta",
            fields: {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        },
        { namespace: ["visualizer_0"] }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
        },
        { namespace: ["visualizer_0"] }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe("image/png");
    await expect(images[0]!.blob).resolves.toMatchObject({
      type: "image/png",
      size: 8,
    });
  });
});
