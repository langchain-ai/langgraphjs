import {
  BaseMessage,
  BaseMessageLike,
  coerceMessageLikeToMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import { v4 } from "@langchain/core/utils/uuid";

/**
 * Special value that signifies the intent to remove all previous messages in the state reducer.
 * Used as the unique identifier for a `RemoveMessage` instance which, when encountered,
 * causes all prior messages to be discarded, leaving only those following this marker.
 */
export const REMOVE_ALL_MESSAGES = "__remove_all__";

/**
 * Type that represents an acceptable input for the messages state reducer.
 *
 * - Can be a single `BaseMessage` or `BaseMessageLike`.
 * - Can be an array of `BaseMessage` or `BaseMessageLike`.
 */
export type Messages =
  | Array<BaseMessage | BaseMessageLike>
  | BaseMessage
  | BaseMessageLike;

/**
 * Reducer function for combining two sets of messages in LangGraph's state system.
 *
 * This reducer handles several tasks:
 * 1. Normalizes both `left` and `right` message inputs to arrays.
 * 2. Coerces any message-like objects into real `BaseMessage` instances.
 * 3. Ensures all messages have unique, stable IDs by generating missing ones.
 * 4. If a `RemoveMessage` instance is encountered in `right` with the ID `REMOVE_ALL_MESSAGES`,
 *    all previous messages are discarded and only the subsequent messages in `right` are returned.
 * 5. Otherwise, merges `left` and `right` messages together following these rules:
 *    - If a message in `right` shares an ID with a message in `left`:
 *      - If it is a `RemoveMessage`, that message (by ID) is marked for removal.
 *      - If it is a normal message, it replaces the message with the same ID from `left`.
 *    - If a message in `right` **does not exist** in `left`:
 *      - If it is a `RemoveMessage`, this is considered an error (cannot remove non-existent ID).
 *      - Otherwise, the message is appended.
 *    - Messages flagged for removal are omitted from the final output.
 *
 * @param left - The existing array (or single message) of messages from current state.
 * @param right - The new array (or single message) of messages to be applied.
 * @returns A new array of `BaseMessage` objects representing the updated state.
 *
 * @throws Error if a `RemoveMessage` is used to delete a message with an ID that does not exist in the merged list.
 *
 * @example
 * ```ts
 * const msg1 = new AIMessage("hello");
 * const msg2 = new HumanMessage("hi");
 * const removal = new RemoveMessage({ id: msg1.id });
 * const newState = messagesStateReducer([msg1], [msg2, removal]);
 * // newState will only contain msg2 (msg1 is removed)
 * ```
 */
export function messagesStateReducer(
  left: Messages,
  right: Messages
): BaseMessage[] {
  // Ensure both left and right are arrays
  const leftArray = Array.isArray(left) ? left : [left];
  const rightArray = Array.isArray(right) ? right : [right];

  // Convert all input to BaseMessage instances
  const leftMessages = (leftArray as BaseMessageLike[]).map(
    coerceMessageLikeToMessage
  );
  const rightMessages = (rightArray as BaseMessageLike[]).map(
    coerceMessageLikeToMessage
  );

  // Assign missing IDs to any message in the left array
  for (const m of leftMessages) {
    if (m.id === null || m.id === undefined) {
      m.id = v4();
      m.lc_kwargs.id = m.id;
    }
  }

  // Assign missing IDs and check for "remove all" marker in right array
  let removeAllIdx: number | undefined;
  for (let i = 0; i < rightMessages.length; i += 1) {
    const m = rightMessages[i];
    if (m.id === null || m.id === undefined) {
      m.id = v4();
      m.lc_kwargs.id = m.id;
    }

    // If RemoveMessage with special REMOVE_ALL_MESSAGES id is found
    if (RemoveMessage.isInstance(m) && m.id === REMOVE_ALL_MESSAGES) {
      removeAllIdx = i;
    }
  }

  // If remove-all is present, all previous messages are wiped; return only subsequent ones
  if (removeAllIdx != null) return rightMessages.slice(removeAllIdx + 1);

  // Begin normal merging logic
  const merged = [...leftMessages];
  const mergedById = new Map(merged.map((m, i) => [m.id, i]));
  const idsToRemove = new Set();

  for (const m of rightMessages) {
    const existingIdx = mergedById.get(m.id);
    if (existingIdx !== undefined) {
      // Case: updating or removing an existing message by id
      if (RemoveMessage.isInstance(m)) {
        idsToRemove.add(m.id);
      } else {
        idsToRemove.delete(m.id);
        merged[existingIdx] = m;
      }
    } else {
      // Case: inserting a completely new message
      if (RemoveMessage.isInstance(m)) {
        throw new Error(
          `Attempting to delete a message with an ID that doesn't exist ('${m.id}')`
        );
      }
      mergedById.set(m.id, merged.length);
      merged.push(m);
    }
  }

  // Remove any messages whose IDs are marked for removal
  return merged.filter((m) => !idsToRemove.has(m.id));
}

/**
 * **Experimental.** Batch reducer for use with `DeltaChannel`.
 *
 * Processes all writes in one pass — dedup by ID and `RemoveMessage`
 * tombstoning — without calling {@link messagesStateReducer}.
 *
 * This reducer is batching-invariant, as required by `DeltaChannel`:
 * `reducer(reducer(state, xs), ys) === reducer(state, xs.concat(ys))`.
 *
 * A `RemoveMessage` carrying the {@link REMOVE_ALL_MESSAGES} sentinel id
 * clears all messages accumulated so far (prior state plus earlier writes in
 * the same batch) and keeps only the messages that follow it, mirroring
 * {@link messagesStateReducer}. Clearing happens in the same single linear
 * pass, so the batching-invariant still holds.
 *
 * Raw object / string inputs are coerced to typed `BaseMessage` objects so
 * that HTTP-driven graphs work without a separate coercion step. This is not
 * full {@link messagesStateReducer} parity — unknown-id `RemoveMessage`
 * errors and missing-id UUID assignment are not handled here.
 *
 * @param state - The current accumulated list of messages.
 * @param writes - Batch of writes, each a single message-like or an array.
 * @returns The new accumulated list of messages.
 *
 * @example
 * ```typescript
 * import { DeltaChannel, messagesDeltaReducer } from "@langchain/langgraph";
 *
 * const channel = new DeltaChannel(messagesDeltaReducer);
 * ```
 */
export function messagesDeltaReducer(
  state: BaseMessage[],
  writes: Messages[]
): BaseMessage[] {
  // Each write is either an array of message-likes or a single message-like.
  // Only arrays flatten; everything else is one message.
  const flat: BaseMessageLike[] = [];
  for (const w of writes) {
    if (Array.isArray(w)) {
      flat.push(...(w as BaseMessageLike[]));
    } else {
      flat.push(w as BaseMessageLike);
    }
  }

  // Steady state: the reducer's own output is already typed, so skip coercion
  // on state when the first element is a BaseMessage. Only raw input (initial
  // objects, deserialized blobs) hits the slow path.
  const stateMsgs: BaseMessage[] =
    state.length > 0 && BaseMessage.isInstance(state[0])
      ? state
      : (state as BaseMessageLike[]).map(coerceMessageLikeToMessage);
  const msgs: BaseMessage[] = flat.map(coerceMessageLikeToMessage);

  const index = new Map<string, number>();
  for (let i = 0; i < stateMsgs.length; i += 1) {
    const mid = stateMsgs[i].id;
    if (mid != null) index.set(mid, i);
  }

  const result: (BaseMessage | null)[] = [...stateMsgs];
  for (const msg of msgs) {
    const mid = msg.id;
    if (RemoveMessage.isInstance(msg) && mid === REMOVE_ALL_MESSAGES) {
      // Discard everything accumulated so far (prior state and earlier writes
      // in this batch); only messages following the sentinel are kept. Doing
      // this inline keeps the reducer batching-invariant.
      result.length = 0;
      index.clear();
    } else if (mid == null) {
      result.push(msg);
    } else if (RemoveMessage.isInstance(msg)) {
      if (index.has(mid)) {
        result[index.get(mid)!] = null;
        index.delete(mid);
      }
    } else if (index.has(mid)) {
      result[index.get(mid)!] = msg;
    } else {
      index.set(mid, result.length);
      result.push(msg);
    }
  }
  return result.filter((m): m is BaseMessage => m !== null);
}
