import { describe, expect, it } from "vitest";
import { checkLangGraphSemver, checkSemver } from "../src/semver/index.mjs";
import { satisfiesPeerRange } from "../src/semver/satisfiesPeerRange.mjs";

describe("checkSemver", () => {
  it("should return the correct semver status for a single package", async () => {
    const result = await checkSemver([
      { name: "@langchain/langgraph", version: "1.3.6" },
    ]);

    expect(result).toMatchObject([
      { name: "@langchain/langgraph", satisfies: true },
    ]);
  });

  it("should handle multiple packages", async () => {
    const result = await checkSemver([
      { name: "@langchain/langgraph", version: "1.3.6" },
      { name: "@langchain/core", version: "0.3.40" },
      { name: "typescript", version: "5.5.4" },
      { name: "some-other-package", version: "1.0.0" },
    ]);

    expect(result).toMatchObject([
      { name: "@langchain/langgraph", satisfies: true },
      { name: "@langchain/core", satisfies: false },
      { name: "typescript", satisfies: true },
    ]);
  });

  it("should handle non-existent packages in peerDependencies", async () => {
    const result = await checkSemver([
      { name: "non-existent-package", version: "1.0.0" },
    ]);
    expect(result).toEqual([]);
  });

  it("should handle empty package array", async () => {
    const result = await checkSemver([]);
    expect(result).toEqual([]);
  });

  it("should handle invalid version strings", async () => {
    const result = await checkSemver([
      { name: "@langchain/langgraph", version: "invalid-version" },
    ]);
    expect(result).toMatchObject([
      { name: "@langchain/langgraph", satisfies: false },
    ]);
  });

  it("should accept prerelease builds for a satisfying release tuple", async () => {
    const result = await checkSemver([
      { name: "@langchain/core", version: "1.1.48-dev-1777587649451" },
      { name: "@langchain/core", version: "1.1.43-dev-1777587649451" },
    ]);

    expect(result).toMatchObject([
      { name: "@langchain/core", satisfies: true },
      { name: "@langchain/core", satisfies: false },
    ]);
  });
});

describe("checkLangGraphSemver", () => {
  it("should report whether installed workspace packages satisfy peer ranges", async () => {
    const result = await checkLangGraphSemver();
    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.name)).toEqual([
      "@langchain/core",
      "@langchain/langgraph",
      "@langchain/langgraph-checkpoint",
    ]);

    for (const entry of result) {
      expect(entry.satisfies).toBe(
        satisfiesPeerRange(entry.version, entry.required)
      );
    }
  });
});
