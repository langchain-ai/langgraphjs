/**
 * Merge `thread_id` into a user-supplied `config.configurable` blob.
 *
 * The platform expects `config.configurable.thread_id` on every run
 * dispatch. Applied last so a user-supplied value can't override the
 * active thread id.
 */
export function bindThreadConfig(
  config: unknown,
  threadId: string
): Record<string, unknown> {
  const base =
    config != null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const configurable =
    base.configurable != null && typeof base.configurable === "object"
      ? (base.configurable as Record<string, unknown>)
      : {};
  return {
    ...base,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
}
