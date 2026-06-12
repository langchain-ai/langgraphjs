/**
 * Splits a single block of prose into up to three paragraphs for the three
 * storybook pages. Tolerates partial text: if the text only has 1 or 2
 * paragraph breaks yet, returns fewer entries so the UI can render pages as the
 * storyteller streams.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 3);
}

/**
 * Derives a lightweight display title from the first paragraph of the story.
 *
 * This is intentionally heuristic: the backend emits exactly three paragraphs
 * and no title, so the client uses the first few words only after enough text
 * has streamed to avoid flashing an unstable one-word heading.
 */
export function deriveTitle(paragraphs: readonly string[]): string {
  const first = paragraphs[0];
  if (first == null || first.length < 30) return "";
  const words = first.split(/\s+/).slice(0, 4).join(" ");
  return words.replace(/[,.;:!?]+$/, "");
}
