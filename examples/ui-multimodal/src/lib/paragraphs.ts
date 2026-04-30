/**
 * Splits a single block of prose into up to three paragraphs for the three
 * storybook pages. Tolerates partial text: if the text only has 1 or 2
 * paragraph breaks yet, returns fewer entries.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 3);
}

/**
 * Derive a title from the first paragraph of the story. Falls back to
 * `"Once upon a time…"` until we have enough words.
 */
export function deriveTitle(paragraphs: readonly string[]): string {
  const first = paragraphs[0];
  if (first == null || first.length < 30) return "";
  const words = first.split(/\s+/).slice(0, 4).join(" ");
  return words.replace(/[,.;:!?]+$/, "");
}
