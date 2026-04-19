/**
 * Experimental v2-native stream runtime (framework-agnostic).
 *
 * This is the pure-TypeScript core every framework binding composes
 * over. It has zero framework imports so React, Vue, Svelte, and
 * Angular bindings can pick their own reactivity primitive and wrap
 * the `subscribe` / `getSnapshot` contract exposed by
 * {@link StreamStore}.
 *
 * Public surfaces:
 *   - {@link StreamController}  — thread lifecycle + imperatives
 *   - {@link ChannelRegistry}   — ref-counted subscription cache
 *   - {@link StreamStore}       — minimal observable primitive
 *   - `*Projection` factories   — per-kind {@link ProjectionSpec}s
 *   - `assembledToBaseMessage`  — `AssembledMessage` → `BaseMessage`
 *
 * See `libs/sdk-react/useStreamExperimental.md` for the React binding
 * design and the intended migration path from `useStream`.
 */
export { StreamStore } from "./store.js";
export type { StoreListener } from "./store.js";

export { ChannelRegistry } from "./channel-registry.js";

export { StreamController, ROOT_PUMP_CHANNELS } from "./controller.js";

export { SubagentDiscovery, SubgraphDiscovery } from "./discovery/index.js";
export type {
  SubagentMap,
  SubgraphMap,
  SubgraphByNodeMap,
} from "./discovery/index.js";

export {
  messagesProjection,
  toolCallsProjection,
  valuesProjection,
  extensionProjection,
  channelProjection,
  audioProjection,
  imagesProjection,
  videoProjection,
  filesProjection,
} from "./projections/index.js";
export type { MediaProjectionOptions } from "./projections/index.js";

export {
  assembledToBaseMessage,
  assembledMessageToBaseMessage,
} from "./assembled-to-message.js";
export type {
  AssembledToMessageInput,
  ExtendedMessageRole,
} from "./assembled-to-message.js";

export type {
  AcquiredProjection,
  ProjectionRuntime,
  ProjectionSpec,
  RootEventBus,
  RootSnapshot,
  StreamControllerOptions,
  StreamSubmitOptions,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  Target,
} from "./types.js";

// Types framework bindings (React, Vue, Svelte, Angular) typically
// need when wrapping the projection factories. Re-exported here so
// bindings can reach them without a deep subpath import.
export type {
  AssembledToolCall,
  ToolCallStatus,
} from "../client/stream/handles/tools.js";

export { MediaAssembler, MediaAssemblyError } from "../client/stream/media.js";
export type {
  AnyMediaHandle,
  AudioMedia,
  FileMedia,
  ImageMedia,
  MediaAssemblerCallbacks,
  MediaAssemblerOptions,
  MediaAssemblyErrorKind,
  MediaBase,
  MediaBlockType,
  VideoMedia,
} from "../client/stream/media.js";

// Protocol primitives that leak through the public surface (e.g.
// `useChannel` returns `Event[]` and accepts `Channel[]`). Re-exported
// here so application code doesn't need a direct dependency on
// `@langchain/protocol`.
export type { Channel, Event } from "@langchain/protocol";
