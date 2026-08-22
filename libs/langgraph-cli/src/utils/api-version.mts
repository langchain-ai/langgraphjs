type ParsedApiVersion = {
  release: number[];
  prerelease: "dev" | "rc" | undefined;
  prereleaseNumber: number;
};

type ApiVersionRange = {
  floor: ParsedApiVersion;
  allowFutureStable: boolean;
};

const API_VERSION_PATTERN =
  /^\d+(?:\.\d+){0,2}(?:(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)|(?:(?:\.|)[A-Za-z][0-9A-Za-z.-]*))?$/;
const API_VERSION_RANGE_PATTERN = /^(~=|>~=)\s*(.+)$/;
const API_VERSION_PART_PATTERN =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:(?:\.|)(dev|rc)(\d+))?$/;

const parseApiVersion = (version: string): ParsedApiVersion | undefined => {
  const match = API_VERSION_PART_PATTERN.exec(version);
  if (match == null) return undefined;

  const [, major, minor, patch, prerelease, prereleaseNumber] = match;
  const release = [major, minor, patch]
    .filter((part): part is string => part !== undefined)
    .map((part) => Number.parseInt(part, 10));

  return {
    release,
    prerelease: prerelease as "dev" | "rc" | undefined,
    prereleaseNumber: Number.parseInt(prereleaseNumber ?? "0", 10),
  };
};

const parseApiVersionRange = (
  apiVersion: string
): ApiVersionRange | undefined => {
  const match = API_VERSION_RANGE_PATTERN.exec(apiVersion);
  if (match == null) return undefined;

  const [, operator, floorVersion] = match;
  const floor = parseApiVersion(floorVersion.trim());
  if (floor == null) return undefined;

  return {
    floor,
    allowFutureStable: operator === ">~=",
  };
};

export const isValidApiVersionSpecifier = (apiVersion: string): boolean =>
  API_VERSION_PATTERN.test(apiVersion) ||
  parseApiVersionRange(apiVersion) != null;

const prereleaseOrder = (
  prerelease: ParsedApiVersion["prerelease"]
): number => {
  if (prerelease === "dev") return 0;
  if (prerelease === "rc") return 1;
  return 2;
};

const compareTuples = (left: number[], right: number[]): number => {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
};

const compareApiVersions = (
  left: ParsedApiVersion,
  right: ParsedApiVersion
): number => {
  const release = compareTuples(left.release, right.release);
  if (release !== 0) return release;

  const prerelease =
    prereleaseOrder(left.prerelease) - prereleaseOrder(right.prerelease);
  if (prerelease !== 0) return prerelease;

  return left.prereleaseNumber - right.prereleaseNumber;
};

const apiVersionUpperBound = (version: ParsedApiVersion): number[] => {
  const major = version.release[0] ?? 0;
  const minor = version.release[1];
  if (version.release.length <= 2) return [major + 1];
  return [major, (minor ?? 0) + 1];
};

const isCompatibleApiVersionCandidate = (
  candidate: ParsedApiVersion,
  range: ApiVersionRange,
  upperBound: number[]
): boolean => {
  if (compareApiVersions(candidate, range.floor) < 0) return false;

  const outsideCompatibleRange =
    compareTuples(candidate.release.slice(0, upperBound.length), upperBound) >=
    0;
  if (outsideCompatibleRange && !range.allowFutureStable) return false;
  if (outsideCompatibleRange && candidate.prerelease != null) return false;
  if (range.floor.prerelease === "dev" && candidate.prerelease === "dev") {
    return compareApiVersions(candidate, range.floor) === 0;
  }
  return true;
};

const getPypiVersions = async (packageName: string): Promise<string[]> => {
  let response: Response;
  try {
    response = await fetch(`https://pypi.org/pypi/${packageName}/json`);
  } catch (error) {
    throw new Error(
      `Failed to fetch PyPI versions for ${packageName}: ${error}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PyPI versions for ${packageName}: ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as { releases?: unknown };
  if (
    payload == null ||
    typeof payload.releases !== "object" ||
    payload.releases == null
  ) {
    throw new Error(
      `Failed to fetch PyPI versions for ${packageName}: invalid response.`
    );
  }

  return Object.keys(payload.releases);
};

export const resolveApiVersion = async (
  apiVersion: string | undefined
): Promise<string | undefined> => {
  if (apiVersion == null) return undefined;

  const range = parseApiVersionRange(apiVersion);
  if (range == null) return apiVersion;

  const candidates = (await getPypiVersions("langgraph-api"))
    .map((version) => ({ version, parsed: parseApiVersion(version) }))
    .filter(
      (candidate): candidate is { version: string; parsed: ParsedApiVersion } =>
        candidate.parsed != null &&
        isCompatibleApiVersionCandidate(
          candidate.parsed,
          range,
          apiVersionUpperBound(range.floor)
        )
    );

  const best = candidates.reduce<(typeof candidates)[number] | undefined>(
    (current, candidate) => {
      if (current == null) return candidate;
      return compareApiVersions(candidate.parsed, current.parsed) > 0
        ? candidate
        : current;
    },
    undefined
  );

  if (best == null) {
    throw new Error(
      `No PyPI releases match compatible api_version range ${apiVersion}.`
    );
  }

  return best.version;
};
