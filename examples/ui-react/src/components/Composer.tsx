import type { FormEvent } from "react";

interface ComposerProps {
  placeholder: string;
  onSubmit: (content: string) => void;
  disabled: boolean;
}

export function Composer({
  placeholder,
  onSubmit,
  disabled,
}: ComposerProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const content = String(data.get("content") ?? "");
    if (!content.trim()) return;
    form.reset();
    onSubmit(content);
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        name="content"
        rows={3}
        disabled={disabled}
        placeholder={placeholder}
        className="composer-textarea"
        onKeyDown={(event) => {
          const target = event.currentTarget;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            target.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">
          Enter to send, Shift+Enter for a new line.
        </span>
        <button className="primary-button" disabled={disabled} type="submit">
          {disabled ? "Streaming..." : "Send"}
        </button>
      </div>
    </form>
  );
}
