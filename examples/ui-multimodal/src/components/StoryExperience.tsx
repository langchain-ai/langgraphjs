import { AIMessage } from "@langchain/core/messages";
import { useStreamContext, useValues } from "@langchain/react";
import { useNodeRun } from "../lib/useNodeRun";
import { deriveTitle, splitParagraphs } from "../lib/paragraphs";
import type { StoryState } from "../lib/types";
import { useStoryApp } from "../lib/useStoryApp";
import { PageCard } from "./PageCard";
import { PromptForm } from "./PromptForm";
import { StorybookHeader } from "./StorybookHeader";

/**
 * Main client-side story flow.
 *
 * The component intentionally renders from two stream surfaces:
 * - `stream.messages` exposes token deltas while the storyteller is still
 *   writing, so the three page cards can fill in progressively.
 * - `useValues(stream).paragraphs` exposes committed graph state after the
 *   storyteller node completes, which becomes the stable source of truth while
 *   image and audio worker nodes continue streaming.
 */
export function StoryExperience() {
  const stream = useStreamContext<StoryState>();
  const {
    started,
    chainPlayEnabled,
    toggleChainPlay,
    resetStory,
  } = useStoryApp();

  const values = useValues<StoryState>(stream);
  const storytellerRun = useNodeRun("storyteller");
  const committedParagraphs = values.paragraphs ?? [];
  const lastStorytellerAI = stream.messages.findLast(AIMessage.isInstance);
  const streamedStoryText = lastStorytellerAI?.text ?? "";
  // Prefer committed paragraphs once available; before then, split the live
  // storyteller text so the UI can show partial pages as tokens arrive.
  const paragraphs =
    committedParagraphs.length === 3
      ? committedParagraphs
      : splitParagraphs(streamedStoryText);
  const title = deriveTitle(paragraphs);

  const isRunning = stream.isLoading;
  const storytellerDone = committedParagraphs.length === 3;
  const storytellerFailed =
    stream.error != null || storytellerRun?.status === "error";

  if (!started) return <PromptForm />;

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
          onClick={resetStory}
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
        onToggleChainPlay={toggleChainPlay}
      />

      <section className="pages">
        {[0, 1, 2].map((i) => (
          <PageCard
            key={i}
            index={i}
            text={paragraphs[i] ?? ""}
          />
        ))}
      </section>

      {!isRunning ? (
        <footer className="app__footer">
          <button
            type="button"
            className="app__footer-btn"
            onClick={resetStory}
          >
            ✨ Tell me another
          </button>
        </footer>
      ) : null}
    </>
  );
}
