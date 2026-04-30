import { useState } from "react";

const THEME_CHIPS: readonly { id: string; label: string; prompt: string }[] = [
  { id: "bunny", label: "sleepy bunny", prompt: "a little bunny who cannot find their bedtime blanket" },
  { id: "starfish", label: "starfish adventure", prompt: "a tiny starfish exploring a moonlit coral reef" },
  { id: "dragon", label: "sleepy dragon", prompt: "a baby dragon who is afraid of the dark" },
  { id: "acorn", label: "brave acorn", prompt: "a brave little acorn rolling home through the forest" },
  { id: "picnic", label: "moon picnic", prompt: "a family of mice having a picnic on the moon" },
  { id: "kitten", label: "cloud kitten", prompt: "a fluffy kitten who naps inside a warm cloud" },
];

export interface PromptFormProps {
  onSubmit: (prompt: string) => void;
  disabled?: boolean;
}

export function PromptForm({ onSubmit, disabled }: PromptFormProps) {
  const [text, setText] = useState("");

  const handleChip = (prompt: string) => {
    if (disabled) return;
    onSubmit(prompt);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled) return;
    onSubmit(trimmed);
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
