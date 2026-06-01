import { useNodeRun } from "../lib/useNodeRun";
import { PageAudio } from "./PageAudio";
import { PageImage } from "./PageImage";

export interface PageCardProps {
  /** Zero-based page index; maps to `visualizer_${index}` and `narrator_${index}`. */
  index: number;
  /** Story paragraph for this page. May be empty while text is still streaming. */
  text: string;
}

/**
 * A single storybook page: illustration, paragraph text, and narration controls.
 *
 * Media lookup lives in `PageImage` and `PageAudio`; this component only
 * composes the page and uses the narrator lifecycle to decide whether to show
 * the text caret while narration is still being prepared.
 */
export function PageCard({ index, text }: PageCardProps) {
  const narrator = useNodeRun(`narrator_${index}`);

  return (
    <article className="page-card" aria-label={`Page ${index + 1}`}>
      <PageImage index={index} />

      <p
        className={`page-card__text${text.length === 0 ? " page-card__text--empty" : ""}`}
      >
        {text.length > 0 ? text : "quietly gathering the words…"}
        {narrator?.status !== "complete" && text.length > 0 ? (
          <span className="page-card__text-caret" />
        ) : null}
      </p>

      <PageAudio index={index} />
    </article>
  );
}
