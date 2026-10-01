import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STUDIO_URL,
  resolveStudioUrl,
} from "../src/cli/utils/studio-url.mjs";

describe("resolveStudioUrl", () => {
  it("prefers the explicit flag without deriving", async () => {
    const deriveUrl = vi.fn(async () => "https://derived.example.com");
    await expect(
      resolveStudioUrl("https://studio.example.com", deriveUrl)
    ).resolves.toBe("https://studio.example.com");
    expect(deriveUrl).not.toHaveBeenCalled();
  });

  it("uses the derived host when no flag is given", async () => {
    await expect(
      resolveStudioUrl(undefined, async () => "https://derived.example.com")
    ).resolves.toBe("https://derived.example.com");
  });

  it("treats an empty flag as absent", async () => {
    await expect(
      resolveStudioUrl("", async () => "https://derived.example.com")
    ).resolves.toBe("https://derived.example.com");
  });

  it("falls back to the default when derivation yields nothing", async () => {
    await expect(
      resolveStudioUrl(undefined, async () => undefined)
    ).resolves.toBe(DEFAULT_STUDIO_URL);
    await expect(resolveStudioUrl(undefined, async () => "")).resolves.toBe(
      DEFAULT_STUDIO_URL
    );
  });

  it("falls back to the default when derivation throws", async () => {
    await expect(
      resolveStudioUrl(undefined, async () => {
        throw new Error("boom");
      })
    ).resolves.toBe(DEFAULT_STUDIO_URL);
  });
});
