import {
  useImages,
  useMediaURL,
  useStreamContext,
} from "@langchain/react";

import { useNodeRun } from "../lib/useNodeRun";
import type { StoryState } from "../lib/types";
import { PlaceholderImage } from "./PlaceholderImage";

/**
 * Renders the generated illustration for one page.
 *
 * Each visualizer node emits media under its own stream namespace. `useNodeRun`
 * discovers that namespace from lifecycle events, then `useImages` subscribes
 * only to image blocks produced by the matching `visualizer_${index}` node.
 */
export function PageImage({ index }: { index: number }) {
  const stream = useStreamContext<StoryState>();
  const visualizer = useNodeRun(`visualizer_${index}`);
  const images = useImages(stream, visualizer?.namespace);
  const image = images[0];
  const imageURL = useMediaURL(image);
  const imageReady = imageURL != null;
  const imageFailed = visualizer?.status === "error" || image?.error != null;

  return (
    <div
      className={`page-card__image-wrap${imageReady || imageFailed ? " page-card__image-wrap--ready" : ""
        }`}
    >
      {imageReady ? (
        <img
          className="page-card__image"
          src={imageURL}
          alt={`Illustration for page ${index + 1}`}
        />
      ) : imageFailed ? (
        <PlaceholderImage muted />
      ) : null}
    </div>
  );
}
