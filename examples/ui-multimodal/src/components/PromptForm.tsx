import { useState } from "react";

import { HumanMessage } from "langchain";
import { useStreamContext } from "@langchain/react";

import type { StoryState } from "../lib/types";
import { useStoryApp } from "../lib/useStoryApp";

const THEME_CHIPS: readonly { id: string; label: string; prompt: string }[] = [
  { id: "bunny", label: "sleepy bunny", prompt: "a little bunny who cannot find their bedtime blanket" },
  { id: "starfish", label: "starfish adventure", prompt: "a tiny starfish exploring a moonlit coral reef" },
  { id: "dragon", label: "sleepy dragon", prompt: "a baby dragon who is afraid of the dark" },
  { id: "acorn", label: "brave acorn", prompt: "a brave little acorn rolling home through the forest" },
  { id: "picnic", label: "moon picnic", prompt: "a family of mice having a picnic on the moon" },
  { id: "kitten", label: "cloud kitten", prompt: "a fluffy kitten who naps inside a warm cloud" },
];

export interface PromptFormProps {
  /** Disables all prompt entry points while an external parent is busy. */
  disabled?: boolean;
}

/**
 * Initial prompt screen for the demo.
 *
 * The form submits directly through `useStreamContext`, which keeps this
 * example close to how an application would interact with `@langchain/react`:
 * collect input, append a human message, and let the stream render updates.
 */
export function PromptForm({ disabled }: PromptFormProps) {
  const stream = useStreamContext<StoryState>();
  const { startStory } = useStoryApp();
  const [text, setText] = useState("");

  const submitPrompt = (prompt: string) => {
    if (disabled) return;
    startStory();
    // The graph's state schema uses the standard `messages` channel, so a
    // single HumanMessage is enough to kick off the storyteller node.
    void stream
      .submit({ messages: [new HumanMessage(prompt)] })
      .catch((err) => {
        console.error("[bedtime-story] submit failed", err);
      });
  };

  const handleChip = (prompt: string) => {
    submitPrompt(prompt);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled) return;
    submitPrompt(trimmed);
  };

  return (
    <form className="prompt-form" onSubmit={handleSubmit}>
      <label className="prompt-form__label">Pick a theme</label>
      <div className="prompt-form__chips">
        {THEME_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="chip"
            onClick={() => handleChip(chip.prompt)}
            disabled={disabled}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <label className="prompt-form__label" htmlFor="prompt-textarea">
        Or describe your own
      </label>
      <textarea
        id="prompt-textarea"
        className="prompt-form__textarea"
        placeholder="a sleepy hedgehog under the stars…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        rows={3}
      />
      <button
        type="submit"
        className="prompt-form__submit"
        disabled={disabled || text.trim().length === 0}
      >
        Tuck me in
      </button>
    </form>
  );
}
