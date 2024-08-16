import fs from "fs";
import semver from "semver";

type DenoJson = {
  imports: Record<string, string>;
};

type PackageJson = {
  // Only adding the fields we care about
  devDependencies: Record<string, string>;
};

function main() {
  const denoJson: DenoJson = JSON.parse(fs.readFileSync("deno.json", "utf-8"));
  const packageJson: PackageJson = JSON.parse(
    fs.readFileSync("examples/package.json", "utf-8")
  );

  // Parse the dependency names and versions from the deno.json file
  const denoDeps = Object.entries(denoJson.imports).map(([name, version]) => {
    let depName = name.endsWith("/") ? name.slice(0, -1) : name;
    let depVersion = version
      .replace(/^npm:\/?(.*)/g, "$1")
      .replace(depName, "");
    depVersion = depVersion.replace(/@.*$/, "").replace(/\/$/, "");
    if (!depVersion || depVersion === "") {
      depVersion = "latest";
    }

    // `latest` is not a valid semver, do not validate it
    if (depVersion !== "latest" && !semver.valid(depVersion)) {
      throw new Error(`Invalid version for ${depName}: ${depVersion}`);
    }
    return { name: depName, version: depVersion };
  });

  // Match the dependencies to those in the `package.json` file, and
  // use the `semver` package to verify the versions are compatible
  denoDeps.forEach((denoDep) => {
    if (!(denoDep.name in packageJson.devDependencies)) {
      throw new Error(
        `Dependency ${denoDep.name} is not in the package.json file`
      );
    }

    const packageVersion = packageJson.devDependencies[denoDep.name];
    if (denoDep.version === "latest") {
      // If the deno version is latest, we can not validate it. Assume it is correct
      return;
    }
    const cleanedPackageJsonVersion =
      semver.clean(packageVersion) ?? packageVersion;
    if (
      cleanedPackageJsonVersion !== denoDep.version &&
      !semver.gte(cleanedPackageJsonVersion, denoDep.version)
    ) {
      throw new Error(
        `Version mismatch for ${denoDep.name}: package.json version ${cleanedPackageJsonVersion} is less than deno.json version ${denoDep.version}`
      );
    }
  });
}

if (import.meta.url === import.meta.resolve("./validate-deps-sync.ts")) {
  main();
}
