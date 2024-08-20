import type { ChannelVersions } from "../checkpoint/base.js";

export function getNewChannelVersions(
  previousVersions: ChannelVersions,
  currentVersions: ChannelVersions
): ChannelVersions {
  // Get new channel versions
  if (Object.keys(previousVersions).length > 0) {
    const versionValues = Object.values(currentVersions);
    const versionType =
      versionValues.length > 0 ? typeof versionValues[0] : undefined;
    let nullVersion: number | string;
    if (versionType === "number") {
      nullVersion = 0;
    } else if (versionType === "string") {
      nullVersion = "";
    }

    return Object.fromEntries(
      Object.entries(currentVersions).filter(
        ([k, v]) => v > (previousVersions[k] ?? nullVersion)
      )
    );
  } else {
    return currentVersions;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _coerceToDict(value: any, defaultKey: string) {
  return value &&
    !Array.isArray(value) &&
    // eslint-disable-next-line no-instanceof/no-instanceof
    !(value instanceof Date) &&
    typeof value === "object"
    ? value
    : { [defaultKey]: value };
}
