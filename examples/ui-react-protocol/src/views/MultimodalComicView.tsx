import { useCallback, useMemo, useState, type FormEvent } from "react";

import type { BaseMessage } from "@langchain/core/messages";
import { useStream } from "@langchain/react";

import type { agent as multimodalComicAgentType } from "../agents/multimodal-comic";
import { EventLog } from "../components/EventLog";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import type { PlaygroundTransportMode } from "../components/ProtocolSwitcher";
import { SubagentPanel } from "../components/SubagentPanel";
import {
  getLastAssistantMetadata,
  getSubagentPreview,
  getTextContent,
  isRecord,
} from "../utils";
import {
  API_URL,
  getTransportLabel,
  getStreamProtocol,
  isProtocolTransportMode,
  summarizeToolEvent,
  summarizeUpdateEvent,
  useTraceLog,
} from "./shared";

const ASSISTANT_ID = "multimodal-comic";
const MAX_CHAPTERS = 6;

const SUGGESTIONS = [
  "A shy maintenance robot discovers a sleeping city beneath the clouds.",
  "Two siblings inherit a map that only appears during thunderstorms.",
  "A tiny sea dragon opens a late-night noodle stand for lost travelers.",
];

type StoryOutlinePayload = {
  kind: "story-outline";
  storyTitle: string;
  logline: string;
  chapterCount: number;
  chapters: Array<{
    chapterNumber: number;
    title: string;
    brief: string;
    imagePrompt: string;
    colorMood: string;
    voiceStyle: string;
  }>;
};

type ChapterScriptPayload = {
  kind: "chapter-script";
  chapterNumber: number;
  title: string;
  narration: string;
  dialogue: string;
  caption: string;
};

type ChapterIllustrationPayload = {
  kind: "chapter-illustration";
  chapterNumber: number;
  title?: string;
  imageDataUrl: string;
  alt?: string;
  caption?: string;
  palette?: string[];
};

type ChapterAudioPayload = {
  kind: "chapter-audio";
  chapterNumber: number;
  title?: string;
  transcript: string;
  voiceStyle?: string;
  durationSeconds?: number;
  audioDataUrl: string;
};

type StructuredPayload =
  | StoryOutlinePayload
  | ChapterScriptPayload
  | ChapterIllustrationPayload
  | ChapterAudioPayload;

type ChapterRenderState = {
  chapterNumber: number;
  title?: string;
  brief?: string;
  imagePrompt?: string;
  colorMood?: string;
  voiceStyle?: string;
  image?: ChapterIllustrationPayload;
  script?: ChapterScriptPayload;
  audio?: ChapterAudioPayload;
};

type StreamLike = {
  values: Record<string, unknown>;
  error: unknown;
  isLoading: boolean;
  messages: BaseMessage[];
  getMessagesMetadata?: (message: BaseMessage) => unknown;
  subagents: Map<
    string,
    {
      id: string;
      status: string;
      result: string | null;
      messages: BaseMessage[];
      toolCalls: Array<{
        id: string;
        call: {
          name: string;
          args: Record<string, unknown> | string;
        };
        result:
          | {
              content: unknown;
            }
          | undefined;
      }>;
      toolCall: {
        args: Record<string, unknown>;
      };
    }
  >;
  submit: (
    input: { messages: Array<{ content: string; type: "human" }> },
    options?: { streamSubgraphs?: boolean }
  ) => void;
};

const buildComicInput = (idea: string, chapterCount: number) =>
  `Create a multimodal comic strip with exactly ${chapterCount} chapter${
    chapterCount === 1 ? "" : "s"
  }.

User concept:
${idea.trim()}

Plan the story, then generate image, narration text, and audio narration for each chapter.`;

const parseJsonCandidate = (value: unknown): StructuredPayload | null => {
  let candidate: unknown = value;

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return null;

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const rawText = fencedMatch?.[1]?.trim() ?? trimmed;

    try {
      candidate = JSON.parse(rawText);
    } catch {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) {
        return null;
      }

      try {
        candidate = JSON.parse(rawText.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }

  if (!isRecord(candidate) || typeof candidate.kind !== "string") {
    return null;
  }

  switch (candidate.kind) {
    case "story-outline":
      return Array.isArray(candidate.chapters)
        ? (candidate as unknown as StoryOutlinePayload)
        : null;
    case "chapter-script":
      return typeof candidate.chapterNumber === "number"
        ? (candidate as unknown as ChapterScriptPayload)
        : null;
    case "chapter-illustration":
      return typeof candidate.chapterNumber === "number" &&
        typeof candidate.imageDataUrl === "string"
        ? (candidate as unknown as ChapterIllustrationPayload)
        : null;
    case "chapter-audio":
      return typeof candidate.chapterNumber === "number" &&
        typeof candidate.audioDataUrl === "string"
        ? (candidate as unknown as ChapterAudioPayload)
        : null;
    default:
      return null;
  }
};

const getPayloadChapterNumber = (
  payload: StructuredPayload
): number | undefined =>
  payload.kind === "story-outline" ? undefined : payload.chapterNumber;

const getChapterNumberFromDescription = (description: unknown) => {
  if (typeof description !== "string") return undefined;
  const match = description.match(/chapter\s+(\d+)/i);
  return match == null ? undefined : Number(match[1]);
};

const getRoleLabel = (subagentType: unknown) => {
  switch (subagentType) {
    case "story-planner":
      return "Story Planner";
    case "chapter-illustrator":
      return "Illustrator";
    case "narration-writer":
      return "Narration Writer";
    case "voice-director":
      return "Voice Director";
    default:
      return "Subagent";
  }
};

const getImageDataUrl = (message: BaseMessage) => {
  if (!Array.isArray(message.content)) return null;

  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

    if (block.type === "image_url") {
      const rawImage = block.image_url;
      if (typeof rawImage === "string" && rawImage.length > 0) {
        return rawImage;
      }
      if (
        isRecord(rawImage) &&
        typeof rawImage.url === "string" &&
        rawImage.url.length > 0
      ) {
        return rawImage.url;
      }
    }
  }

  return null;
};

const estimateDurationSeconds = (transcript: string) => {
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  return Number(Math.max(1, (wordCount / 150) * 60).toFixed(2));
};

const extractImagePayloadFromMessages = (
  subagent: StreamLike["subagents"] extends Map<string, infer TValue>
    ? TValue
    : never
): ChapterIllustrationPayload | null => {
  const chapterNumber = getChapterNumberFromDescription(
    subagent.toolCall.args.description
  );
  if (chapterNumber == null) return null;

  for (let index = subagent.messages.length - 1; index >= 0; index -= 1) {
    const message = subagent.messages[index];
    if (message?.type !== "ai") continue;

    const imageDataUrl = getImageDataUrl(message);
    if (imageDataUrl == null) continue;

    const caption = getTextContent(message).trim();
    return {
      kind: "chapter-illustration",
      chapterNumber,
      imageDataUrl,
      alt:
        caption.length > 0
          ? caption
          : `Generated illustration for chapter ${chapterNumber}`,
      caption: caption.length > 0 ? caption : undefined,
    };
  }

  return null;
};

const extractAudioPayloadFromMessages = (
  subagent: StreamLike["subagents"] extends Map<string, infer TValue>
    ? TValue
    : never
): ChapterAudioPayload | null => {
  const chapterNumber = getChapterNumberFromDescription(
    subagent.toolCall.args.description
  );
  if (chapterNumber == null) return null;

  for (let index = subagent.messages.length - 1; index >= 0; index -= 1) {
    const message = subagent.messages[index];
    if (message?.type !== "ai") continue;

    const additionalKwargs = isRecord(message.additional_kwargs)
      ? message.additional_kwargs
      : undefined;
    const audio = isRecord(additionalKwargs?.audio)
      ? additionalKwargs.audio
      : undefined;
    const data = typeof audio?.data === "string" ? audio.data : undefined;
    if (data == null || data.length === 0) continue;

    const transcript =
      typeof audio?.transcript === "string" && audio.transcript.trim().length > 0
        ? audio.transcript.trim()
        : getTextContent(message).trim();

    return {
      kind: "chapter-audio",
      chapterNumber,
      transcript,
      audioDataUrl: `data:audio/wav;base64,${data}`,
      durationSeconds:
        transcript.length > 0 ? estimateDurationSeconds(transcript) : undefined,
    };
  }

  return null;
};

const collectSubagentPayloads = (
  subagent: StreamLike["subagents"] extends Map<string, infer TValue>
    ? TValue
    : never
) => {
  const payloads: StructuredPayload[] = [];
  const seen = new Set<string>();
  const registerPayload = (payload: StructuredPayload | null) => {
    if (payload == null) return;
    const key = `${payload.kind}:${getPayloadChapterNumber(payload) ?? "outline"}`;
    if (seen.has(key)) return;
    seen.add(key);
    payloads.push(payload);
  };

  for (const toolCall of subagent.toolCalls) {
    registerPayload(parseJsonCandidate(toolCall.result?.content));
  }

  registerPayload(parseJsonCandidate(subagent.result));
  registerPayload(extractImagePayloadFromMessages(subagent));
  registerPayload(extractAudioPayloadFromMessages(subagent));

  return payloads;
};

export function MultimodalComicView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  return isProtocolTransportMode(transportMode) ? (
    <ProtocolMultimodalComicView transportMode={transportMode} />
  ) : (
    <LegacyMultimodalComicView />
  );
}

function LegacyMultimodalComicView() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const stream = useStream<typeof multimodalComicAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    fetchStateHistory: true,
    filterSubagentMessages: true,
    streamProtocol: "legacy",
    throttle: true,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const handleSubmit = useCallback(
    (idea: string, chapterCount: number) => {
      const input = {
        messages: [{ content: buildComicInput(idea, chapterCount), type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input, { streamSubgraphs: true });
    },
    [stream]
  );

  return (
    <MultimodalComicPlayground
      description="This view exercises a Deep Agent that fans work out to planning, illustration, narration, and AI voice subagents."
      eventLog={eventLog}
      onSubmit={handleSubmit}
      protocolLabel={getTransportLabel("legacy")}
      stream={stream as unknown as StreamLike}
      threadId={threadId}
    />
  );
}

function ProtocolMultimodalComicView({
  transportMode,
}: {
  transportMode: Exclude<PlaygroundTransportMode, "legacy">;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();

  const stream = useStream<typeof multimodalComicAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    fetchStateHistory: true,
    filterSubagentMessages: true,
    streamProtocol: getStreamProtocol(transportMode),
    throttle: true,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const handleSubmit = useCallback(
    (idea: string, chapterCount: number) => {
      const input = {
        messages: [{ content: buildComicInput(idea, chapterCount), type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input, { streamSubgraphs: true });
    },
    [stream]
  );

  return (
    <MultimodalComicPlayground
      description="This protocol-backed variant streams the root coordinator plus every chapter asset pipeline as the comic strip fills in."
      eventLog={eventLog}
      onSubmit={handleSubmit}
      protocolLabel={getTransportLabel(transportMode)}
      stream={stream as unknown as StreamLike}
      threadId={threadId}
    />
  );
}

function MultimodalComicPlayground({
  stream,
  threadId,
  protocolLabel,
  description,
  eventLog,
  onSubmit,
}: {
  stream: StreamLike;
  threadId: string | null;
  protocolLabel: string;
  description: string;
  eventLog: ReturnType<typeof useTraceLog>["eventLog"];
  onSubmit: (idea: string, chapterCount: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [chapterCount, setChapterCount] = useState(1);
  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.getMessagesMetadata, stream.messages],
  );

  const subagentEntries = useMemo(
    () => Array.from(stream.subagents.values()),
    [stream.subagents]
  );

  const renderState = useMemo(() => {
    let outline: StoryOutlinePayload | null = null;
    const chapters = new Map<number, ChapterRenderState>();

    for (const subagent of subagentEntries) {
      for (const payload of collectSubagentPayloads(subagent)) {
        if (payload.kind === "story-outline") {
          outline = payload;
          for (const chapter of payload.chapters) {
            const existing = chapters.get(chapter.chapterNumber) ?? {
              chapterNumber: chapter.chapterNumber,
            };
            chapters.set(chapter.chapterNumber, {
              ...existing,
              chapterNumber: chapter.chapterNumber,
              title: chapter.title,
              brief: chapter.brief,
              imagePrompt: chapter.imagePrompt,
              colorMood: chapter.colorMood,
              voiceStyle: chapter.voiceStyle,
            });
          }
          continue;
        }

        const existing = chapters.get(payload.chapterNumber) ?? {
          chapterNumber: payload.chapterNumber,
        };
        if (payload.kind === "chapter-illustration") {
          chapters.set(payload.chapterNumber, {
            ...existing,
            title: existing.title ?? payload.title,
            image: payload,
          });
          continue;
        }
        if (payload.kind === "chapter-script") {
          chapters.set(payload.chapterNumber, {
            ...existing,
            title: existing.title ?? payload.title,
            script: payload,
          });
          continue;
        }
        chapters.set(payload.chapterNumber, {
          ...existing,
          title: existing.title ?? payload.title,
          voiceStyle: existing.voiceStyle ?? payload.voiceStyle,
          audio: payload,
        });
      }
    }

    const orderedChapters = Array.from(chapters.values()).sort(
      (left, right) => left.chapterNumber - right.chapterNumber
    );

    return {
      outline,
      chapters: orderedChapters,
      stats: {
        illustrationReady: orderedChapters.filter((chapter) => chapter.image != null)
          .length,
        narrationReady: orderedChapters.filter((chapter) => chapter.script != null)
          .length,
        audioReady: orderedChapters.filter((chapter) => chapter.audio != null).length,
      },
    };
  }, [subagentEntries]);

  const subagents = useMemo(
    () =>
      subagentEntries.map((subagent) => {
        const payloads = collectSubagentPayloads(subagent);
        const payloadChapter =
          payloads.find((payload) => payload.kind !== "story-outline") ?? null;
        const chapterNumber =
          (payloadChapter != null ? getPayloadChapterNumber(payloadChapter) : undefined) ??
          getChapterNumberFromDescription(subagent.toolCall.args.description);
        const roleLabel = getRoleLabel(subagent.toolCall.args.subagent_type);
        const title =
          chapterNumber != null && roleLabel !== "Story Planner"
            ? `Chapter ${chapterNumber} · ${roleLabel}`
            : roleLabel;
        const preview =
          getSubagentPreview(subagent.messages) ??
          (typeof subagent.result === "string" && subagent.result.trim().length > 0
            ? subagent.result.trim().slice(0, 120)
            : undefined);

        return {
          id: subagent.id,
          title,
          status: subagent.status,
          messageCount: subagent.messages.length,
          preview,
        };
      }),
    [subagentEntries]
  );

  const snapshot = useMemo(
    () => ({
      assistantId: ASSISTANT_ID,
      protocol: protocolLabel,
      threadId,
      userSelectedChapterCount: chapterCount,
      rootMessageCount: stream.messages.length,
      subagentCount: subagentEntries.length,
      storyTitle: renderState.outline?.storyTitle ?? null,
      generatedChapters: renderState.chapters.length,
      illustrationReady: renderState.stats.illustrationReady,
      narrationReady: renderState.stats.narrationReady,
      audioReady: renderState.stats.audioReady,
    }),
    [
      chapterCount,
      protocolLabel,
      renderState.chapters.length,
      renderState.outline?.storyTitle,
      renderState.stats.audioReady,
      renderState.stats.illustrationReady,
      renderState.stats.narrationReady,
      stream.messages.length,
      subagentEntries.length,
      threadId,
    ]
  );

  const handleSuggestion = useCallback(
    (idea: string) => {
      setDraft(idea);
      onSubmit(idea, chapterCount);
    },
    [chapterCount, onSubmit]
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = draft.trim();
      if (trimmed.length === 0) return;
      onSubmit(trimmed, chapterCount);
      setDraft("");
    },
    [chapterCount, draft, onSubmit]
  );

  return (
    <section className="playground-shell">
      <header className="hero-card">
        <div>
          <div className="eyebrow">Protocol testbed</div>
          <h2>Multimodal Comic Strip</h2>
          <p>{description}</p>
        </div>
        <dl className="hero-metadata">
          <div>
            <dt>Assistant</dt>
            <dd>{ASSISTANT_ID}</dd>
          </div>
          <div>
            <dt>API</dt>
            <dd>{API_URL}</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{protocolLabel}</dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd>{threadId ?? "pending"}</dd>
          </div>
        </dl>
      </header>

      {stream.error != null ? (
        <div className="error-banner">
          {stream.error instanceof Error
            ? stream.error.message
            : "The multimodal stream failed."}
        </div>
      ) : null}

      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            className="suggestion-chip"
            disabled={stream.isLoading}
            onClick={() => handleSuggestion(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <div>
              <h3>Comic Strip</h3>
              <div className="subagent-meta">
                {renderState.outline?.storyTitle ?? "Waiting for story planner..."}
              </div>
            </div>
            <span className="conversation-status">
              {stream.isLoading ? "Streaming assets..." : "Ready"}
            </span>
          </div>

          <section className="comic-strip-panel">
            <div className="comic-strip-header">
              <div>
                <h3>{renderState.outline?.storyTitle ?? "No story yet"}</h3>
                <p>
                  {renderState.outline?.logline ??
                    "Submit a prompt to watch the planner, illustrator, narrator, and voice director fill in the strip."}
                </p>
              </div>
              <div className="comic-stat-row">
                <span className="comic-stat-chip">
                  Art {renderState.stats.illustrationReady}/{renderState.chapters.length || 0}
                </span>
                <span className="comic-stat-chip">
                  Text {renderState.stats.narrationReady}/{renderState.chapters.length || 0}
                </span>
                <span className="comic-stat-chip">
                  Audio {renderState.stats.audioReady}/{renderState.chapters.length || 0}
                </span>
              </div>
            </div>

            {renderState.chapters.length === 0 ? (
              <div className="empty-feed">
                <h3>Nothing rendered yet</h3>
                <p>
                  The comic cards will appear chapter by chapter as structured
                  subagent outputs stream in.
                </p>
              </div>
            ) : (
              <div className="comic-strip-grid">
                {renderState.chapters.map((chapter) => (
                  <article
                    key={chapter.chapterNumber}
                    className="comic-chapter-card"
                  >
                    <div className="comic-chapter-header">
                      <div>
                        <div className="eyebrow">
                          Chapter {chapter.chapterNumber}
                        </div>
                        <h3>{chapter.title ?? `Chapter ${chapter.chapterNumber}`}</h3>
                      </div>
                      <div className="comic-status-row">
                        <span
                          className={`status-pill status-${
                            chapter.image ? "completed" : "pending"
                          }`}
                        >
                          Art
                        </span>
                        <span
                          className={`status-pill status-${
                            chapter.script ? "completed" : "pending"
                          }`}
                        >
                          Text
                        </span>
                        <span
                          className={`status-pill status-${
                            chapter.audio ? "completed" : "pending"
                          }`}
                        >
                          Audio
                        </span>
                      </div>
                    </div>

                    <p className="comic-chapter-brief">
                      {chapter.brief ?? "Waiting for the planner's chapter brief..."}
                    </p>

                    <div className="comic-image-frame">
                      {chapter.image != null ? (
                        <img
                          alt={
                            chapter.image.alt ??
                            chapter.image.caption ??
                            chapter.title ??
                            `Chapter ${chapter.chapterNumber} illustration`
                          }
                          className="comic-image"
                          src={chapter.image.imageDataUrl}
                        />
                      ) : (
                        <div className="comic-placeholder">
                          Illustration streaming...
                        </div>
                      )}
                    </div>

                    <div className="comic-body-grid">
                      <section className="comic-copy-card">
                        <div className="comic-section-label">Narration</div>
                        <p>
                          {chapter.script?.narration ??
                            "Narration writer is still drafting this chapter."}
                        </p>
                        <div className="comic-dialogue">
                          {chapter.script?.dialogue ?? "Dialogue pending."}
                        </div>
                        <div className="comic-caption">
                          {chapter.script?.caption ??
                            chapter.image?.caption ??
                            chapter.imagePrompt ??
                            "Caption pending."}
                        </div>
                      </section>

                      <section className="comic-copy-card">
                        <div className="comic-section-label">Voice</div>
                        <div className="comic-audio-meta">
                          {chapter.audio?.voiceStyle ||
                            chapter.voiceStyle ||
                            "Voice style pending"}
                        </div>
                        {chapter.audio != null ? (
                          <>
                            <audio
                              className="comic-audio-player"
                              controls
                              preload="metadata"
                              src={chapter.audio.audioDataUrl}
                            />
                            <div className="comic-audio-meta">
                              {chapter.audio.durationSeconds != null
                                ? `${chapter.audio.durationSeconds}s AI-generated narration`
                                : "AI-generated narration"}
                            </div>
                          </>
                        ) : (
                          <div className="comic-placeholder comic-placeholder-small">
                            Audio rendering...
                          </div>
                        )}
                      </section>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="panel-card-header">
            <h3>Coordinator Conversation</h3>
            <span className="conversation-status">
              {stream.messages.length} message{stream.messages.length === 1 ? "" : "s"}
            </span>
          </div>

          <MessageFeed
            getMessageMetadata={stream.getMessagesMetadata}
            messages={stream.messages}
          />

          <form className="composer comic-compose-form" onSubmit={handleSubmit}>
            <textarea
              className="composer-textarea"
              disabled={stream.isLoading}
              name="content"
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="Describe the comic idea you want to generate."
              rows={4}
              value={draft}
            />
            <div className="comic-compose-row">
              <label className="comic-chapter-count-field">
                <span className="comic-section-label">Chapters</span>
                <input
                  className="comic-chapter-count-input"
                  disabled={stream.isLoading}
                  max={MAX_CHAPTERS}
                  min={1}
                  onChange={(event) => {
                    const nextValue = Number(event.currentTarget.value);
                    if (Number.isNaN(nextValue)) {
                      setChapterCount(1);
                      return;
                    }
                    setChapterCount(
                      Math.max(1, Math.min(MAX_CHAPTERS, Math.trunc(nextValue)))
                    );
                  }}
                  type="number"
                  value={chapterCount}
                />
              </label>
              <div className="composer-actions comic-compose-actions">
                <span className="composer-hint">
                  Pick 1-{MAX_CHAPTERS} chapters. More chapters create more parallel
                  subagent work.
                </span>
                <button
                  className="primary-button"
                  disabled={stream.isLoading}
                  type="submit"
                >
                  {stream.isLoading ? "Streaming..." : "Generate comic"}
                </button>
              </div>
            </div>
          </form>
        </section>

        <aside className="sidebar-stack">
          <SubagentPanel subagents={subagents} />
          <JsonPanel title="Render Snapshot" value={snapshot} />
          <JsonPanel title="Story Outline" value={renderState.outline} />
          <JsonPanel title="Current State" value={stream.values} />
          <JsonPanel title="Last Assistant Metadata" value={metadata} />
          <EventLog eventLog={eventLog} />
        </aside>
      </div>
    </section>
  );
}
