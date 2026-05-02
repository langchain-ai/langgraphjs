import * as url from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as semver from "semver";

const packageJsonPath = path.resolve(
  url.fileURLToPath(import.meta.url),
  "../../../package.json"
);

export async function checkSemver(
  packages: { name: string; version: string }[]
): Promise<
  { name: string; version: string; required: string; satisfies: boolean }[]
> {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
  const peerDependencies: Record<string, string> =
    packageJson.peerDependencies ?? {};

  return packages.flatMap((pkg) => {
    const required = peerDependencies[pkg.name];
    if (!required) return [];

    const satisfies = satisfiesPeerRange(pkg.version, required);
    return { ...pkg, required, satisfies };
  });
}

function satisfiesPeerRange(version: string, required: string): boolean {
  if (semver.satisfies(version, required, { includePrerelease: true })) {
    return true;
  }

  const parsed = semver.parse(version);
  if (parsed == null || parsed.prerelease.length === 0) {
    return false;
  }

  // CI often installs internal dev builds such as
  // `1.1.44-dev-<timestamp>`. Semver orders those below the final
  // `1.1.44`, so `^1.1.44` does not match directly even though the
  // build targets that release line. Validate the release tuple as a
  // compatibility check while still rejecting prereleases below range.
  const releaseVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return semver.satisfies(releaseVersion, required, {
    includePrerelease: true,
  });
}

export async function checkLangGraphSemver() {
  const resolveVersion = async (name: string) => {
    let version = "0.0.0";
    try {
      const pkgJson = await import(`${name}/package.json`);
      if (pkgJson == null || typeof pkgJson !== "object") {
        return { name, version };
      }

      if (
        "default" in pkgJson &&
        typeof pkgJson.default === "object" &&
        pkgJson.default != null
      ) {
        version = pkgJson.default.version || version;
      } else if ("version" in pkgJson) {
        version = pkgJson.version || version;
      }
    } catch {
      // pass
    }
    return { name, version };
  };

  const validate = [
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/langgraph-checkpoint",
  ];

  const resolved = await Promise.all(
    validate.map((name) => resolveVersion(name))
  );
  return checkSemver(resolved);
}
