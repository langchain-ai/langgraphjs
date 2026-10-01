export const DEFAULT_STUDIO_URL = "https://smith.langchain.com";

/**
 * Resolves the Studio host the same way as the Python CLI: an explicit
 * `--studio-url` wins, then the host derived from the LangSmith endpoint,
 * then the public LangSmith host. `deriveUrl` only runs without a flag.
 */
export async function resolveStudioUrl(
  studioUrl: string | undefined,
  deriveUrl: () => Promise<string | undefined>
): Promise<string> {
  if (studioUrl) return studioUrl;
  try {
    return (await deriveUrl()) || DEFAULT_STUDIO_URL;
  } catch {
    return DEFAULT_STUDIO_URL;
  }
}
