# Scenario 2: Multimodal Story Creation

## Description

A supervisor agent coordinates three specialized subagents to create an
illustrated, narrated short story:

- **Writer** — generates the story text, chapter by chapter
- **Illustrator** — creates images for each chapter (calls an image generation API)
- **Narrator** — produces audio narration for each chapter (calls a TTS API)

The supervisor orchestrates the pipeline: Writer produces a chapter, then
Illustrator and Narrator work on it in parallel. The frontend displays a
rich, synchronized experience: text appears as the Writer streams tokens,
images load as the Illustrator generates them, and audio plays as the
Narrator produces it — all for the same chapter, in sync.

This scenario validates whether the protocol can handle heterogeneous
modalities from concurrent subagents with synchronized playback.

## Agent Setup

```typescript
import { StateGraph, Annotation, MessagesAnnotation, Send } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

const StoryState = Annotation.Root({
  ...MessagesAnnotation.spec,
  chapters: Annotation<Chapter[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  currentChapter: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
});

interface Chapter {
  number: number;
  text: string;
  imageUrl?: string;
  audioStreamId?: number;
}

// Writer: streams text tokens via messages channel
async function writer(state: typeof StoryState.State, config) {
  const llm = new ChatOpenAI({ model: "gpt-4o" });
  const response = await llm.invoke([
    { role: "system", content: "Write chapter " + state.currentChapter + " of a short story." },
    ...state.messages,
  ], config);

  return {
    chapters: [{ number: state.currentChapter, text: response.content }],
    messages: [response],
  };
}

// Illustrator: generates an image, writes it to sandbox filesystem
async function illustrator(state: typeof StoryState.State, config) {
  const chapter = state.chapters[state.currentChapter - 1];
  const imageBuffer = await generateImage(chapter.text); // DALL-E / Stable Diffusion
  const path = `/workspace/output/chapter_${chapter.number}.png`;
  await fs.writeFile(path, imageBuffer);

  return {
    chapters: [{
      ...chapter,
      imageUrl: path,
    }],
  };
}

// Narrator: produces audio via TTS, streams it via config.writer
async function narrator(state: typeof StoryState.State, config) {
  const chapter = state.chapters[state.currentChapter - 1];
  const writer = config.writer;

  // Stream audio chunks as they're generated
  const audioStream = await textToSpeech(chapter.text, { voice: "alloy" });
  for await (const chunk of audioStream) {
    // Each chunk is a PCM audio buffer
    writer?.({
      type: "audio_chunk",
      chapter: chapter.number,
      data: chunk, // ArrayBuffer
    });
  }

  return { chapters: [{ ...chapter, audioStreamId: chapter.number }] };
}

const graph = new StateGraph(StoryState)
  .addNode("writer", writer)
  .addNode("illustrator", illustrator)
  .addNode("narrator", narrator)
  .addNode("supervisor", supervisorNode)
  .addEdge("__start__", "supervisor")
  .addConditionalEdges("supervisor", routeToNextStep)
  // After writer completes, illustrator and narrator run in parallel
  .addConditionalEdges("writer", () => [
    new Send("illustrator", {}),
    new Send("narrator", {}),
  ])
  .compile();
```

## v1: Current Approach

```typescript
// v1: stream with messages + custom + subgraphs
for await (const chunk of await graph.stream(
  { messages: [{ role: "user", content: "Write a 3-chapter mystery story" }] },
  { streamMode: ["messages", "custom"], subgraphs: true }
)) {
  const [namespace, mode, data] = chunk;

  if (mode === "messages") {
    // Text tokens — but from which subagent?
    // Must parse namespace to figure out if this is the writer
    const isWriter = namespace.some(n => n.includes("writer"));
    if (isWriter) {
      renderChapterText(data[0].content);
    }
  }

  if (mode === "custom") {
    // Audio chunks come through custom channel
    if (data.type === "audio_chunk") {
      // Raw audio data... but it's been JSON-serialized!
      // ArrayBuffer → Base64 string → JSON → parse → decode
      // +33% overhead on every 20ms audio chunk
      playAudioChunk(base64Decode(data.data));
    }
  }
}
```

**Problems with v1**:

1. **No binary streaming**: Audio data must be Base64-encoded to fit in
   JSON. At 24kHz 16-bit PCM, that's ~96 KB/s of raw audio becoming
   ~128 KB/s after Base64 — and the JSON serialization/parse overhead
   on every 20ms chunk dominates CPU.

2. **No image change notifications**: The illustrator writes a PNG to
   the filesystem, but v1 has no way to notify the frontend that a
   new file appeared. The client must poll or use a separate API.

3. **No synchronized playback**: There is no mechanism to link text
   tokens to audio timestamps. The frontend can't highlight text as
   audio plays.

4. **All events interleaved**: Writer tokens, narrator audio, and
   illustrator activity all arrive in one stream. The frontend must
   parse namespaces and `data.type` to route events.

5. **Everything or nothing**: If the user only wants to watch Chapter 2's
   narration, they still receive all events from all chapters and all
   subagents.

## v2: Protocol Approach

### In-Process

```typescript
import { createSession } from "@langchain/langgraph/protocol";

const session = createSession(graph, {
  input: { messages: [{ role: "user", content: "Write a 3-chapter mystery story" }] },
});

// Subscribe to lifecycle to track subagent progress
const lifecycle = session.subscribe("lifecycle");

// Subscribe to writer's text output
const writerText = session.subscribe("messages", {
  namespaces: [["writer"]],
});

// Subscribe to illustrator's file changes
const illustrations = session.subscribe("resource", {
  namespaces: [["illustrator"]],
});

// Subscribe to narrator's audio (binary, zero-copy)
const narration = session.subscribe("media", {
  namespaces: [["narrator"]],
  mediaTypes: ["audio"],
});

// Process each stream independently
await Promise.all([
  // Render chapter text as it streams
  (async () => {
    for await (const event of writerText) {
      renderChapterText(event.params.data.message.content);
    }
  })(),

  // Load images as illustrator creates them
  (async () => {
    for await (const event of illustrations) {
      if (event.params.data.changes.some(c => c.type === "created" && c.path.endsWith(".png"))) {
        const img = await session.resource.read(
          ["illustrator"],
          event.params.data.changes[0].path,
          { encoding: "binary" }
        );
        displayChapterImage(img);
      }
    }
  })(),

  // Play audio as narrator produces it
  (async () => {
    for await (const event of narration) {
      if (event.method === "media.streamStart") {
        initAudioPlayer(event.params.data.codec, event.params.data.sampleRate);
      }
      // Binary audio frames arrive as ArrayBuffer — no Base64!
      if (event.method === "media.data") {
        playAudioChunk(event.params.data); // Raw PCM bytes
      }
    }
  })(),

  // Track overall progress
  (async () => {
    for await (const event of lifecycle) {
      updateProgressBar(event.params.data);
    }
  })(),
]);
```

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";
import { useEffect, useRef, useState } from "react";

function StoryCreator() {
  const transport = useRef(
    new ProtocolStreamTransport({ url: "ws://localhost:2024/v2/runs" })
  ).current;

  const thread = useStream({
    transport,
    assistantId: "story-agent",
  });

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // Subscribe to resource events for image notifications
    const resourceSub = transport.subscribe("resource", {
      namespaces: [["illustrator"]],
    });

    // Subscribe to media events for audio
    const mediaSub = transport.subscribe("media", {
      namespaces: [["narrator"]],
      mediaTypes: ["audio"],
    });

    // Handle image arrivals
    (async () => {
      for await (const event of resourceSub) {
        for (const change of event.params.data.changes) {
          if (change.type === "created" && change.path.endsWith(".png")) {
            const content = await transport.resource.read(["illustrator"], change.path);
            setChapters(prev => updateChapterImage(prev, change.path, content));
          }
        }
      }
    })();

    // Handle audio streaming
    (async () => {
      for await (const event of mediaSub) {
        if (event.method === "media.streamStart") {
          audioRef.current = initAudioPlayer(event.params.data);
        } else if (event.method === "media.data") {
          audioRef.current?.decodeAudioData(event.params.data);
        }
      }
    })();

    return () => {
      resourceSub.unsubscribe();
      mediaSub.unsubscribe();
    };
  }, [transport]);

  return (
    <div className="story-creator">
      {/* Chapter text comes from useStream's messages (works via existing rendering) */}
      {thread.messages.map((msg) => (
        <ChapterView key={msg.id} message={msg} />
      ))}

      {/* Images and audio come from protocol subscriptions */}
      {chapters.map((ch) => (
        <div key={ch.number}>
          {ch.imageUrl && <img src={ch.imageUrl} alt={`Chapter ${ch.number}`} />}
          {ch.audioStreamId && <AudioPlayer streamId={ch.audioStreamId} />}
        </div>
      ))}
    </div>
  );
}
```

## Protocol Analysis

### Can v1 handle this? **Partially, with significant limitations.**

v1 can stream text tokens and route custom payloads by parsing namespaces.
But it fundamentally cannot:

| Limitation | Impact |
|------------|--------|
| No binary streaming | Audio must be Base64-encoded (+33% overhead, CPU-intensive at 50fps chunk rate) |
| No file change events | Frontend can't know when the illustrator finishes an image without polling |
| No media synchronization | No correlation IDs linking text ↔ audio timestamps |
| No selective subscription | Client receives everything from every subagent, even unused events |
| No media lifecycle | No `streamStart`/`streamEnd` — client can't init audio player with codec info before first chunk |

### What does v2 enable?

| Capability | How |
|------------|-----|
| **Zero-copy audio streaming** | `media` channel delivers PCM bytes via WebSocket binary frames — no Base64, no JSON serialization |
| **File change notifications** | `resource.changed` events fire when the illustrator writes a PNG |
| **File download** | `resource.read` fetches the image content through the same connection |
| **Audio lifecycle** | `media.streamStart` provides codec, sample rate, channels before first audio byte |
| **Selective subscription** | Subscribe to `messages` from writer only, `media` from narrator only — server filters |
| **Synchronized playback** | Correlation IDs in message events link text spans to audio timestamps |
| **Progress tracking** | `lifecycle` events show which subagent is active without parsing namespaces |

### Verdict

This scenario **requires v2**. v1 can technically produce audio through the
custom channel, but the Base64 overhead, lack of media lifecycle, and absence
of file change notifications make it impractical for a production multimodal
experience. v2's binary frames, media module, and resource module are
essential enablers.
