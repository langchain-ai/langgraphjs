import { useRef } from "react";
import { ArrowUp } from "lucide-react";

interface MessageInputProps {
  onSubmit: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({
  onSubmit,
  disabled = false,
  placeholder = "Send a message...",
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const content = formData.get("content") as string;

    if (!content.trim()) return;

    form.reset();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    onSubmit(content);
  };

  return (
    <footer className="border-t border-neutral-800">
      <div className="max-w-2xl mx-auto px-4 py-4">
        <form className="relative" onSubmit={handleSubmit}>
          <div className="relative bg-neutral-900 rounded-xl border border-neutral-800 focus-within:border-brand-dark transition-colors">
            <textarea
              ref={textareaRef}
              name="content"
              placeholder={placeholder}
              rows={1}
              disabled={disabled}
              className="w-full bg-transparent text-white placeholder-neutral-500 px-4 py-3 pr-12 resize-none focus:outline-none text-sm leading-relaxed max-h-[200px] disabled:opacity-50"
              onInput={handleTextareaInput}
              onKeyDown={(e) => {
                const target = e.target as HTMLTextAreaElement;

                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  target.form?.requestSubmit();
                }
              }}
            />

            <button
              type="submit"
              disabled={disabled}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-brand-accent hover:bg-brand-light disabled:bg-neutral-700 disabled:cursor-not-allowed text-black disabled:text-neutral-500 transition-colors"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>

          <p className="text-center text-xs text-neutral-600 mt-3">
            <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-mono text-[10px]">
              Enter
            </kbd>{" "}
            to send ·{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-mono text-[10px]">
              Shift + Enter
            </kbd>{" "}
            for new line
          </p>
        </form>
      </div>
    </footer>
  );
}

