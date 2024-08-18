import { ChannelVersions } from "../checkpoint/base.js";

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
