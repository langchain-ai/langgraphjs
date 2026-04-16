// Use Web Crypto API (works in both Node.js and Cloudflare Workers)
const randomUUID = (): string => crypto.randomUUID();

export interface SegmentRef {
  sid: string;
  end: number;
}

export type SegmentRecipe = SegmentRef[];

export function totalItemCount(recipe: SegmentRecipe): number {
  let count = 0;
  for (const ref of recipe) {
    count += ref.end;
  }
  return count;
}

/**
 * Compute the new segment recipe and the items to write for a list channel.
 *
 * @param parentRecipe - The parent checkpoint's recipe (empty array if no parent).
 * @param newListLength - Length of the full list in the new checkpoint.
 * @param hasOtherChildren - Whether the parent already has another child (fork detection).
 * @param isVerifiedAppend - Whether the caller has verified the new list is a pure append
 *   (i.e., newList[0..parentCount] === parent's list). When false, a full replacement is assumed.
 * @returns The new recipe and which items are new (startIdx in the full list, segment to write to).
 */
export function computeRecipeForPut(
  parentRecipe: SegmentRecipe,
  newListLength: number,
  hasOtherChildren: boolean,
  isVerifiedAppend: boolean
): {
  recipe: SegmentRecipe;
  newItemsStart: number;
  segmentId: string;
} {
  const parentCount = totalItemCount(parentRecipe);

  // No parent or empty parent — first checkpoint or root
  if (parentRecipe.length === 0 || parentCount === 0) {
    const segmentId = randomUUID();
    return {
      recipe:
        newListLength > 0 ? [{ sid: segmentId, end: newListLength }] : [],
      newItemsStart: 0,
      segmentId,
    };
  }

  // List shrunk or was fully replaced — new standalone segment
  if (newListLength < parentCount || !isVerifiedAppend) {
    const segmentId = randomUUID();
    return {
      recipe:
        newListLength > 0 ? [{ sid: segmentId, end: newListLength }] : [],
      newItemsStart: 0,
      segmentId,
    };
  }

  // No new items — copy parent recipe verbatim
  if (newListLength === parentCount) {
    return {
      recipe: [...parentRecipe.map((r) => ({ ...r }))],
      newItemsStart: parentCount,
      segmentId: parentRecipe[parentRecipe.length - 1].sid,
    };
  }

  // Verified append — fork or continue?
  if (hasOtherChildren) {
    // Fork: create new segment for the delta
    const segmentId = randomUUID();
    const newRecipe = parentRecipe.map((r) => ({ ...r }));
    newRecipe.push({ sid: segmentId, end: newListLength - parentCount });
    return {
      recipe: newRecipe,
      newItemsStart: parentCount,
      segmentId,
    };
  }

  // Linear continuation: extend last segment
  const lastSegment = parentRecipe[parentRecipe.length - 1];
  const newRecipe = parentRecipe.map((r) => ({ ...r }));
  newRecipe[newRecipe.length - 1] = {
    sid: lastSegment.sid,
    end: lastSegment.end + (newListLength - parentCount),
  };
  return {
    recipe: newRecipe,
    newItemsStart: parentCount,
    segmentId: lastSegment.sid,
  };
}
