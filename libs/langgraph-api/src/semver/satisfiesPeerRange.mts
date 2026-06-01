import * as semver from "semver";

export function satisfiesPeerRange(version: string, required: string): boolean {
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
