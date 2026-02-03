/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import { computed, ref, type ComputedRef, type Ref } from "vue";

export function useControllableThreadId(options?: {
  threadId?: string | null;
  onThreadId?: (threadId: string) => void;
}): [ComputedRef<string | null>, (threadId: string) => void] {
  const localThreadId = ref<string | null>(options?.threadId ?? null);

  const setThreadId = (threadId: string) => {
    localThreadId.value = threadId;
    options?.onThreadId?.(threadId);
  };

  // Mirror React behavior: only treat as "controlled" when the `threadId` key exists.
  const isControlled = !!options && "threadId" in options;
  const threadId: Ref<string | null> | ComputedRef<string | null> = isControlled
    ? computed(() => options.threadId ?? null)
    : localThreadId;

  return [threadId as ComputedRef<string | null>, setThreadId];
}
