import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStreamContext } from "@langchain/react";
import type { PagePlaybackHandle, StoryState } from "./types";
import { StoryAppContext } from "./useStoryApp";

/**
 * App-level UI state shared by the demo components.
 *
 * This provider deliberately sits inside `StreamProvider`: reset logic needs
 * access to `stream.stop()`, and page audio components register playback
 * handles here so the header can orchestrate "read the whole story aloud"
 * without prop drilling through every card.
 */
export function StoryAppProvider({
  children,
  onReset,
}: {
  children: ReactNode;
  onReset: () => void;
}) {
  const stream = useStreamContext<StoryState>();
  const [started, setStarted] = useState(false);
  const [chainPlayEnabled, setChainPlayEnabled] = useState(false);
  const pageRefs = useRef<(PagePlaybackHandle | null)[]>([]);

  useEffect(() => {
    if (!chainPlayEnabled) {
      pageRefs.current.forEach((r) => r?.pause());
      return;
    }

    let cancelled = false;
    // Chain-play waits for each page's `playToEnd()` promise before advancing,
    // so a user hears page 1, then page 2, then page 3.
    (async () => {
      for (let i = 0; i < 3; i += 1) {
        if (cancelled) return;
        const ref = pageRefs.current[i];
        if (ref == null) return;
        try {
          await ref.play();
        } catch {
          return;
        }
      }
      if (!cancelled) setChainPlayEnabled(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [chainPlayEnabled]);

  const setPageRef = useCallback(
    (index: number, ref: PagePlaybackHandle | null) => {
      pageRefs.current[index] = ref;
    },
    []
  );

  const resetStory = useCallback(() => {
    pageRefs.current.forEach((r) => r?.pause());
    if (stream.isLoading) void stream.stop();
    setChainPlayEnabled(false);
    onReset();
  }, [onReset, stream]);

  return (
    <StoryAppContext.Provider
      value={{
        started,
        startStory: () => setStarted(true),
        chainPlayEnabled,
        toggleChainPlay: () => setChainPlayEnabled((p) => !p),
        setPageRef,
        resetStory,
      }}
    >
      {children}
    </StoryAppContext.Provider>
  );
}
