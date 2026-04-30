import { useEffect, useRef, useState } from "react";
import { AIMessage } from "@langchain/core/messages";
import {
  useStream,
  useMessages,
  type UseStreamReturn,
} from "@langchain/react";
import "./App.css";
import { PromptForm } from "./components/PromptForm";
import { StorybookHeader } from "./components/StorybookHeader";
import { PageCard, type PageCardHandle } from "./components/PageCard";
import { deriveTitle, splitParagraphs } from "./lib/paragraphs";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:2024";
const ASSISTANT_ID = "bedtime-story";

function App() {
  const [epoch, setEpoch] = useState(0);
  return (
    <main className="app">
      <header className="app__hero">
        <h1 className="app__hero-title">Tonight's Story</h1>
        <p className="app__hero-subtitle">
          A tiny illustrated bedtime story, read aloud just for you.
        </p>
      </header>
      <StreamRoot key={epoch} onReset={() => setEpoch((n) => n + 1)} />
    </main>
  );
}

interface StreamRootProps {
  onReset: () => void;
}

function StreamRoot({ onReset }: StreamRootProps) {
  const stream = useStream({
    apiUrl: API_URL,
    assistantId: ASSISTANT_ID,
    transport: "sse",
  });

  const [started, setStarted] = useState(false);

  const handlePromptSubmit = (prompt: string) => {
    setStarted(true);
    void stream
      .submit({ messages: [{ type: "human", content: prompt }] })
      .catch((err) => {
        console.error("[bedtime-story] submit failed", err);
      });
  };

  if (!started) return <PromptForm onSubmit={handlePromptSubmit} />;
  return <StoryBody stream={stream} onReset={onReset} />;
}

interface StoryBodyProps {
  stream: UseStreamReturn;
  onReset: () => void;
}

function StoryBody({ stream, onReset }: StoryBodyProps) {
  const [chainPlayEnabled, setChainPlayEnabled] = useState(false);
  const pageRefs = useRef<(PageCardHandle | null)[]>([]);

  const storytellerSubgraph = stream.subgraphsByNode.get("storyteller")?.[0];
  const storytellerMessages = useMessages(stream, storytellerSubgraph);

  // One subgraph per page per modality — see `agent.ts`. `subgraphsByNode`
  // is keyed by the name passed to `addNode(...)`; each bucket preserves
  // insertion order so parallel fan-outs with the same node name remain
  // addressable positionally.
  //
  // Page 1 (index 1) is the video page: its illustration comes from the
  // `videographer_1` node (Sora 2) instead of the Responses-API image tool.
  const visualizerSubgraphs = [
    stream.subgraphsByNode.get("visualizer_0")?.[0],
    undefined,
    stream.subgraphsByNode.get("visualizer_2")?.[0],
  ];
  const videographerSubgraph = stream.subgraphsByNode.get("videographer_1")?.[0];
  const narratorSubgraphs = [
    stream.subgraphsByNode.get("narrator_0")?.[0],
    stream.subgraphsByNode.get("narrator_1")?.[0],
    stream.subgraphsByNode.get("narrator_2")?.[0],
  ];

  const lastStorytellerAI = storytellerMessages.findLast(AIMessage.isInstance);
  const storytellerText = lastStorytellerAI ? lastStorytellerAI.text : "";
  const paragraphs = splitParagraphs(storytellerText);
  const title = deriveTitle(paragraphs);

  const isRunning = stream.isLoading;
  const storytellerDone = storytellerSubgraph?.status === "complete";
  const storytellerFailed = storytellerSubgraph?.status === "error";

  useEffect(() => {
    if (!chainPlayEnabled) {
      pageRefs.current.forEach((r) => r?.pause());
      return;
    }
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 3; i += 1) {
        if (cancelled) return;
        const ref = pageRefs.current[i];
        if (ref == null) return;
        try {
          await ref.play();
        } catch {
          return;
        }
      }
      if (!cancelled) setChainPlayEnabled(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chainPlayEnabled]);

  const handleReset = () => {
    pageRefs.current.forEach((r) => r?.pause());
    if (isRunning) void stream.stop();
    onReset();
  };

  if (storytellerFailed) {
    return (
      <div className="error-card">
        <h3 className="error-card__title">Hmm, the story got tangled.</h3>
        <p className="error-card__hint">
          Let's try a different idea and start over.
        </p>
        <button
          type="button"
          className="app__footer-btn"
          onClick={handleReset}
        >
          ← Start again
        </button>
      </div>
    );
  }

  return (
    <>
      <StorybookHeader
        title={title}
        isStreaming={isRunning && !storytellerDone}
        chainPlayEnabled={chainPlayEnabled}
        onToggleChainPlay={() => setChainPlayEnabled((p) => !p)}
      />

      <section className="pages">
        {[0, 1, 2].map((i) => (
          <PageCard
            key={i}
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
            index={i}
            text={paragraphs[i] ?? ""}
            stream={stream}
            variant={i === 1 ? "video" : "image"}
            visualizerSubgraph={visualizerSubgraphs[i]}
            videographerSubgraph={i === 1 ? videographerSubgraph : undefined}
            narratorSubgraph={narratorSubgraphs[i]}
          />
        ))}
      </section>

      {!isRunning ? (
        <footer className="app__footer">
          <button
            type="button"
            className="app__footer-btn"
            onClick={handleReset}
          >
            ✨ Tell me another
          </button>
        </footer>
      ) : null}
    </>
  );
}

export default App;
