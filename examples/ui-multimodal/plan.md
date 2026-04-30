# Bedtime Story — Multimodal Deepagents Demo

A minimal storybook app that takes a prompt from the user and produces a 3-page
illustrated bedtime story with narration. Built to showcase the new multimodal
streaming primitives in `@langchain/langgraph-sdk` (`thread.audio`,
`thread.images`, `useAudio`, `useImages`, `useMediaURL`).

## High-level flow

```
User types a prompt
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Coordinator (deepagent, gpt-4o-mini)                   │
│                                                         │
│   1. call `storyteller`     → 3 paragraphs of story     │
│                                                         │
│   2. fan out in parallel:                               │
│        • call `visualizer` × 3 (one per paragraph)      │
│        • call `narrator`   × 3 (one per paragraph)      │
└─────────────────────────────────────────────────────────┘
      │
      ▼
Stream is flat, but each subagent runs in its own namespace,
so the UI uses `subagent.images` / `subagent.audio` positionally
(Nth visualizer handle → Nth page image; same for narrator).
```

The UI renders three page cards up front (as skeletons) and progressively fills
them as text → image → audio stream in.

---

## Agent stack (locked)

| Role | Model | Provider behavior | Emits |
|---|---|---|---|
| coordinator | `gpt-4o-mini` via `deepagents` | calls `task` tool | structured tool calls only |
| `storyteller` subagent | `gpt-4o-mini` | plain model, no tools | text content |
| `visualizer` subagent | `gpt-4.1` + Responses API `image_generation` tool (built-in) | plain model, no user tools | `additional_kwargs.tool_outputs` → needs normalizer → `ImageBlock` |
| `narrator` subagent | `gpt-4o-audio-preview` with `audio: { voice: "nova", format: "wav" }` | plain model, no tools | `additional_kwargs.audio` → existing normalizer → `AudioBlock` |

All four run as "plain model" subagents (no user-defined tools). The
visualizer's built-in Responses `image_generation` tool is invoked by the model
internally; we don't expose it as a deepagents `tools` array.

### Small enabling change in `langgraph-api`

Add `normalizeImageBlockFromAdditionalKwargs` to
`libs/langgraph-api/src/protocol/session/state-normalizers.mts` that mirrors
the existing audio normalizer. It should:

- Inspect `AIMessage.additional_kwargs.tool_outputs[]` for entries with
  `type: "image_generation_call"`.
- For each such output, emit a synthetic `ImageBlock` event
  (`mime_type: "image/png"`, `source_type: "base64"`, `data: <base64>`) on the
  `messages` channel as a `content-block-start` + `content-block-finish`.
- Wire it next to `normalizeAudioBlockFromAdditionalKwargs` in the message
  normalization path.

This is the only change outside the `ui-multimodal` folder.

---

## File layout

```
examples/ui-multimodal/
  langgraph.json              # registers "bedtime-story" assistant
  turbo.json                  # dev pipeline: `langgraphjs dev` + `vite` in parallel
  package.json                # + sdk / react / openai / deepagents / zod deps
  .env.example                # OPENAI_API_KEY
  plan.md                     # this file
  src/
    agent.ts                  # deepagent + 3 subagents
    main.tsx                  # entry (existing)
    App.tsx                   # shell: header, prompt form, story area
    App.css                   # global layout
    index.css                 # palette, typography, reset
    components/
      PromptForm.tsx          # theme chips + free-form input + submit
      StorybookHeader.tsx     # title + "Read me the story" toggle + retry
      PageCard.tsx            # one page: image, text, audio controls
      Shimmer.tsx             # shared loading placeholder
      PlaceholderImage.tsx    # soft SVG used on image failures
    hooks/
      useChainPlay.ts         # sequential auto-play across page audios
    lib/
      agents.ts               # re-export of assistant id, graph name
      theme-prompts.ts        # the 6 theme chip texts
    assets/
      quicksand/              # self-hosted Quicksand woff2 files
```

---

## Agent design (`src/agent.ts`)

```ts
import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";

const storyteller = {
  name: "storyteller",
  description: "Writes a warm, cozy, 3-paragraph bedtime story.",
  prompt: `You are a gentle storyteller for children ages 3–7.
Write exactly 3 short paragraphs (2–3 sentences each) telling one cohesive,
calming bedtime story based on the user's prompt. No violence, no scary
elements, no sharp conflict. Warm, soft, comforting tone. Each paragraph
should stand on its own as a page of a picture book.`,
  model: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.9 }),
};

const visualizer = {
  name: "visualizer",
  description:
    "Generates a single soft watercolor illustration for a paragraph.",
  prompt: `You are an illustrator for a children's picture book. Given one
paragraph, generate exactly one image using the image_generation tool. Style:
soft watercolor, pastel palette, dreamy lighting, rounded cozy shapes, no
scary elements, no sharp contrast, no text in the image. Composition is
centered and calm.`,
  model: new ChatOpenAI({ model: "gpt-4.1" }).bindTools([
    {
      type: "image_generation",
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    },
  ]),
};

const narrator = {
  name: "narrator",
  description: "Reads a paragraph aloud in a warm, soothing voice.",
  prompt: `You are a warm, gentle narrator reading a child to sleep. Read
the given paragraph aloud at a calm, slow pace. Do not add any extra words,
greetings, or commentary. Just read the paragraph exactly as written.`,
  model: new ChatOpenAI({
    model: "gpt-4o-audio-preview",
    modalities: ["text", "audio"],
    audio: { voice: "nova", format: "wav" },
  }),
};

export const graph = createDeepAgent({
  model: new ChatOpenAI({ model: "gpt-4o-mini" }),
  instructions: `You are the coordinator for a bedtime story app.

Given a user prompt, do exactly this in order:
1. Call the storyteller subagent with the user's prompt. It returns 3 paragraphs.
2. For each paragraph (in order), IN PARALLEL, call:
    - the visualizer with that paragraph
    - the narrator with that paragraph
3. Once all 6 subagent calls have returned, respond "Here's your story." and stop.

Do not write or invent your own narrative. Do not summarize. Just orchestrate.`,
  subagents: [storyteller, visualizer, narrator],
});
```

Registered as `bedtime-story` in `langgraph.json`.

---

## UI design

### Layout

- Viewport: centered 520 px-wide column on desktop, full-width on mobile.
- Soft pastel background gradient (`#fef6f0` → `#eef2fb`).
- Quicksand font, self-hosted woff2.
- Border radius `28px`, shadows `0 8px 24px -12px rgba(90, 70, 140, 0.25)`.

### Before submission

- Large friendly title: **"Tonight's Story"**
- 6 theme chips (rounded pill buttons): `sleepy bunny`, `starfish adventure`,
  `sleepy dragon`, `brave acorn`, `moon picnic`, `cloud kitten`.
- Optional free-form textarea (`placeholder: "or type your own idea..."`).
- Primary button: **"Tuck me in"** (disabled until a chip or text is present).
- Clicking a chip auto-fills the textarea and submits, OR submits immediately
  if the textarea is empty. Decision: **chip click auto-submits** to keep flow
  fast for tired parents.

### During streaming

- Header appears with:
  - Story title area (slowly revealed via typewriter as the storyteller text
    arrives — we derive the title from the first 3–5 words of paragraph 1, or
    show "Once upon a time..." until paragraph 1 has ≥ 30 chars).
  - **🔊 Read me the story** toggle on the right (turns chain-auto-play on/off).
  - **↻ Retry failed parts** only visible when ≥ 1 subagent errored; triggers
    a targeted re-run of the failed subagent(s) by resuming the thread (see
    "Error handling" below).

- Three **page cards**, pre-rendered as skeletons immediately on submit.
  Each card contains, top to bottom:
  1. **Image area** (aspect-ratio 1/1, rounded, shimmer until image arrives).
  2. **Paragraph text** (typewriter as it streams; shimmer lines before text
     starts).
  3. **Audio row** (play button + tiny horizontal progress line + duration).
     - Disabled + grey when no audio yet.
     - Becomes active with subtle pulse when the clip is ready.

### After streaming

- Everything static, all three pages fully rendered.
- Header chain-play toggle works end-to-end.
- Footer button: **"✨ Tell me another"** → resets state, creates a new thread,
  scrolls to top.

### Typography scale

- Title: Quicksand 700, 32px, letter-spacing `-0.02em`.
- Paragraph: Quicksand 500, 18px, line-height 1.7, color `#4a4360`.
- Buttons: Quicksand 600, 15px.

### Palette (CSS vars in `index.css`)

```
--bg-gradient-top:    #fef6f0
--bg-gradient-bottom: #eef2fb
--card-bg:            #ffffff
--ink:                #4a4360
--muted:              #9a94a8
--accent:             #d9a7c9   (rosy pink)
--accent-dark:        #b584a3
--shimmer:            #f0eaf4
```

---

## Wiring multimodal streams

### In `App.tsx` (high level)

```tsx
import { useStream, useAudio, useImages } from
  "@langchain/langgraph-sdk/react/experimental";

const thread = useStream({
  apiUrl: "http://localhost:2024",
  assistantId: "bedtime-story",
});

// whole-thread view (namespace ∅ = all) for the 3 paragraphs from the
// storyteller — we get these via the message stream, not media.
const messages = thread.messages;

// Images and audio: we want them scoped per-subagent.
// deepagents exposes subagents via `thread.subagents`.
const subagents = thread.subagents;
```

### Positional correlation

`deepagents` emits subagent handles in order. We track "the Nth call of
`name = 'visualizer'`" as page N's image, and "the Nth call of
`name = 'narrator'`" as page N's audio.

Concretely:

```tsx
function Page({ index }: { index: number }) {
  const visualizerHandle = useNthSubagent("visualizer", index);
  const narratorHandle   = useNthSubagent("narrator", index);

  const images = useImages(visualizerHandle);  // AsyncIterable → [ImageMedia]
  const audios = useAudio(narratorHandle);     // AsyncIterable → [AudioMedia]

  const imgSrc   = useMediaURL(images[0]);
  const audioSrc = useMediaURL(audios[0]);

  // paragraph text comes from the Nth storyteller-emitted paragraph, parsed
  // out of thread.messages.
  ...
}
```

`useNthSubagent` is a small helper inside `hooks/` that subscribes to
`thread.subagents` and returns the Nth handle matching `name`.

### Paragraph extraction

The storyteller emits one AI message whose text is the 3 paragraphs
concatenated. We split on `\n\n` after the message is complete (or best-effort
during streaming so typewriter reveal works per-page). This lives in
`lib/paragraphs.ts`.

---

## Error handling

- Each subagent call is independently tried. If the visualizer fails for page
  N, `useImages(visualizerHandle)` stays empty → `PageCard` shows
  `<PlaceholderImage />` (a soft SVG of a sleeping moon on pastel wash).
- If the narrator fails for page N, the audio button stays disabled with a
  tiny muted "🔇 audio unavailable" label.
- If the storyteller itself fails, we show a single centered card:
  **"Hmm, the story got tangled. Let's try again."** with a primary retry
  button that resubmits the original prompt in a new thread.
- The header-level **"↻ Retry failed parts"** button appears only when the
  top-level run is done AND ≥ 1 subagent errored. Clicking it resubmits just
  the failing paragraph(s) by starting a follow-up run on the same thread
  with a directive like `Re-run visualizer for paragraph 2.`

---

## Runtime & dev scripts

`examples/ui-multimodal/langgraph.json`:

```json
{
  "node_version": "20",
  "graphs": { "bedtime-story": "./src/agent.ts:graph" },
  "env": ".env"
}
```

`examples/ui-multimodal/turbo.json`:

```json
{
  "extends": ["//"],
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true,
      "dependsOn": ["^build"]
    }
  }
}
```

`examples/ui-multimodal/package.json` script:

```json
"scripts": {
  "dev": "concurrently -k \"langgraphjs dev --no-browser --port 2024\" \"vite\"",
  "build": "tsc -b && vite build",
  "preview": "vite preview"
}
```

Runtime deps to add: `@langchain/langgraph-sdk`, `@langchain/react` (hooks live
under `@langchain/langgraph-sdk/react/experimental` — no extra package),
`@langchain/langgraph`, `@langchain/openai`, `deepagents`, `zod`,
`concurrently`.

Dev deps: `@langchain/langgraph-cli`.

---

## Operational notes / known quirks

- **Progressive image reveal is out of scope.** `@langchain/openai` currently
  drops `response.image_generation_call.partial_image` chunks (see
  `chat_models.ts` around the `noop/fixme` comment). Images appear all at
  once when generation completes; shimmer placeholder fills the gap.
- **Transcript display** is omitted — the paragraph text already IS the
  transcript. No per-word sync.
- **Persistence** is none — refresh wipes state. `"Tell me another"` resets
  to a fresh thread.
- **Content safety** relies on the storyteller + visualizer system prompts.
  No separate moderation pass.
- **Rate limits.** Three parallel `image_generation` + three parallel audio
  generations may hit tier-1 OpenAI rate caps. Deepagents' built-in retry
  covers transient 429s; persistent failures degrade to placeholder/muted.
- **Language.** English only; no locale switcher.

---

## Implementation task list

1. **`libs/langgraph-api` — image block normalizer** (only change outside
   `examples/ui-multimodal`).
2. **Scaffold `examples/ui-multimodal`** — deps, `langgraph.json`, `.env.example`,
   `turbo.json`, dev script.
3. **`src/agent.ts`** — deepagent + 3 subagents.
4. **Palette + Quicksand + `index.css` + `App.css`.**
5. **`PromptForm`** — theme chips + textarea + submit button.
6. **`StorybookHeader`** — title + chain-play toggle + retry.
7. **`PageCard`** — image / typewriter text / audio controls + skeleton states.
8. **`useNthSubagent`, `paragraphs.ts`, `useChainPlay.ts`** helpers.
9. **Wire everything in `App.tsx`** via `useStream`.
10. **`PlaceholderImage` + error degradation.**
11. **Manual QA pass** — happy path, single-subagent failure, full failure,
    chain-play, "Tell me another".
12. **Run `pnpm build` in both `libs/langgraph-api` and `examples/ui-multimodal`;
    `pnpm lint` and `pnpm format`.**
