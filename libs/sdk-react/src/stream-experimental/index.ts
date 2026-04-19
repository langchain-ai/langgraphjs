/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

/**
 * Experimental v2-native React hook + selector hooks.
 *
 * Design doc: `libs/sdk-react/useStreamExperimental.md`.
 *
 * The public surface is two layers:
 *   1. `useStreamExperimental`  — thread-centric root hook. Always-on
 *      root projections (values/messages/toolCalls/interrupts) plus
 *      cheap discovery maps for subagents and subgraphs.
 *   2. selector hooks           — render-time subscriptions scoped to
 *      a namespace (subagent, subgraph, arbitrary). Each mount opens
 *      (or joins) one ref-counted subscription; each unmount releases
 *      it. Only channels actually rendered on screen ever hit the
 *      server.
 *
 * Framework-agnostic primitives (controller, registry, projection
 * factories) live in `@langchain/langgraph-sdk/stream`
 * and are shared with Vue/Svelte/Angular bindings.
 */
export {
  useStreamExperimental,
  STREAM_CONTROLLER,
  type UseStreamExperimentalOptions,
  type UseStreamExperimentalReturn,
} from "./use-stream.js";

export { useProjection } from "./use-projection.js";

export {
  useMessages,
  useToolCalls,
  useValues,
  useExtension,
  useChannel,
  useAudio,
  useImages,
  useVideo,
  useFiles,
} from "./selectors.js";
export type { SelectorTarget } from "./selectors.js";

export { useMediaURL } from "./use-media-url.js";
export {
  useProgressiveAudio,
  type ProgressiveAudioState,
  type UseProgressiveAudioOptions,
} from "./use-progressive-audio.js";

// Re-export framework-agnostic types users reach for on the React side.
export type {
  AnyMediaHandle,
  AssembledToolCall,
  AudioMedia,
  Channel,
  Event,
  FileMedia,
  ImageMedia,
  MediaAssemblyErrorKind,
  MediaBase,
  MediaBlockType,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  StreamSubmitOptions,
  ToolCallStatus,
  VideoMedia,
} from "@langchain/langgraph-sdk/stream";

export { MediaAssemblyError } from "@langchain/langgraph-sdk/stream";
