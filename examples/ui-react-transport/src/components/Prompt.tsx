import { useState } from "react";

import { HumanMessage } from "@langchain/core/messages";
import { useStreamContext } from "@langchain/react";

import type { GraphType } from "../app";

export function Prompt() {
    const stream = useStreamContext<GraphType>();
    const [content, setContent] = useState("");
    return (
        <form
            className="composer"
            onSubmit={(e) => {
                e.preventDefault();
                const nextContent = content.trim();
                if (nextContent.length === 0) return;

                setContent("");
                void stream.submit({
                    messages: [new HumanMessage(nextContent)],
                });
            }}
        >
            <textarea
                aria-label="Message"
                name="content"
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                    const target = e.target as HTMLTextAreaElement;

                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        target.form?.requestSubmit();
                    }
                }}
                placeholder="Ask a follow-up..."
                rows={3}
                value={content}
            />
            <button disabled={content.trim() === ""} type="submit">
                Send
            </button>
        </form>
    );
}