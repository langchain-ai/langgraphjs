/**
 * Projection factories (framework-agnostic).
 *
 * Each factory returns a {@link ProjectionSpec} — an opaque descriptor
 * that the {@link ChannelRegistry} turns into a single shared,
 * ref-counted server subscription. Framework-specific selector hooks
 * (`useMessages`, `useToolCalls`, …) wrap these factories.
 */
export { messagesProjection } from "./messages.js";
export { toolCallsProjection } from "./tool-calls.js";
export { valuesProjection } from "./values.js";
export { extensionProjection } from "./extension.js";
export { channelProjection } from "./channel.js";
export type { ChannelProjectionOptions } from "./channel.js";
export {
  audioProjection,
  imagesProjection,
  videoProjection,
  filesProjection,
} from "./media.js";
export type { MediaProjectionOptions } from "./media.js";
