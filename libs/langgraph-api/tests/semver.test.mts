import { minVersion } from "semver";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { checkLangGraphSemver, checkSemver } from "../src/semver/index.mjs";
import { satisfiesPeerRange } from "../src/semver/satisfiesPeerRange.mjs";

function minimumPeerVersion(name: keyof typeof packageJson.peerDependencies) {
  const required = packageJson.peerDependencies[name];
  const version = minVersion(required);
  if (version == null) {
    throw new Error(`Invalid peer range for ${name}: ${required}`);
  }
  return version;
}

describe("checkSemver", () => {
  it("should return the correct semver status for a single package", async () => {
    // Preserve prerelease suffixes when the peer range targets an RC.
    const version = minimumPeerVersion("@langchain/langgraph").version;
    const result = await checkSemver([
      { name: "@langchain/langgraph", version },
    ]);

    expect(result).toEqual([
      {
        name: "@langchain/langgraph",
        version,
        required: packageJson.peerDependencies["@langchain/langgraph"],
        satisfies: true,
      },
    ]);
  });

  it("should handle multiple packages", async () => {
    const result = await checkSemver([
      {
        name: "@langchain/langgraph",
        version: minimumPeerVersion("@langchain/langgraph").version,
      },
      { name: "@langchain/core", version: "0.3.40" },
      { name: "typescript", version: minimumPeerVersion("typescript").version },
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
    const { major, minor, patch } = minimumPeerVersion("@langchain/core");
    const result = await checkSemver([
      {
        name: "@langchain/core",
        version: `${major}.${minor}.${patch}-dev-1777587649451`,
      },
      { name: "@langchain/core", version: "0.3.40-dev-1777587649451" },
    ]);

    expect(result).toMatchObject([
      { name: "@langchain/core", satisfies: true },
      { name: "@langchain/core", satisfies: false },
    ]);
  });
});

describe("satisfiesPeerRange", () => {
  it.each([
    { version: "1.3.6", satisfies: false },
    { version: "1.4.14-rc.0", satisfies: false },
    { version: "1.4.15-rc.0", satisfies: true },
    { version: "1.4.15-rc.1", satisfies: true },
    { version: "1.4.15", satisfies: true },
  ])("checks $version against an RC peer range", ({ version, satisfies }) => {
    expect(satisfiesPeerRange(version, "^1.4.15-rc.0")).toBe(satisfies);
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
