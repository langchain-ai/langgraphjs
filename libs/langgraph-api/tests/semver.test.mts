import { describe, expect, it } from "vitest";
import { checkLangGraphSemver, checkSemver } from "../src/semver/index.mjs";

describe("checkSemver", () => {
  it("should return the correct semver status for a single package", async () => {
    const result = await checkSemver([
      { name: "@langchain/langgraph", version: "0.2.64" },
    ]);

    expect(result).toMatchObject([
      { name: "@langchain/langgraph", satisfies: true },
    ]);
  });

  it("should handle multiple packages", async () => {
    const result = await checkSemver([
      { name: "@langchain/langgraph", version: "0.2.57" },
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
});

describe("checkLangGraphSemver", () => {
  it("should return the correct semver status for LangGraph", async () => {
    const result = await checkLangGraphSemver();
    expect(result).toMatchObject([
      { name: "@langchain/core", satisfies: true },
      { name: "@langchain/langgraph", satisfies: true },
      { name: "@langchain/langgraph-checkpoint", satisfies: true },
    ]);
  });
});
