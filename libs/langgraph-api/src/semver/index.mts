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

    const satisfies = semver.satisfies(pkg.version, required);
    return { ...pkg, required, satisfies };
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
