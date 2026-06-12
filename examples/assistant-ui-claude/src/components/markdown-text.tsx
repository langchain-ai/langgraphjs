"use client";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive className="prose prose-invert prose-p:my-0 prose-pre:my-3 prose-code:text-[0.9em] max-w-none" />
  );
}
