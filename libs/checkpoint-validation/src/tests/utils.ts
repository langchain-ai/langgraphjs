import { platform, arch } from "node:os";

function isMSeriesMac() {
  return platform() === "darwin" && arch() === "arm64";
}

function isWindows() {
  return platform() === "win32";
}

export function isCI() {
  // eslint-disable-next-line no-process-env
  return (process.env.CI ?? "").toLowerCase() === "true";
}

/**
 * GitHub Actions doesn't support containers on m-series macOS due to a lack of hypervisor support for nested
 * virtualization.
 *
 * For details, see https://github.com/actions/runner-images/issues/9460#issuecomment-1981203045
 *
 * GitHub actions also doesn't support Linux containers on Windows, and may never do so. This is in part due to Docker
 * Desktop licensing restrictions, and the complexity of setting up Moby or similar without Docker Desktop.
 * Unfortunately, TestContainers doesn't support windows containers, so we can't run the tests on Windows either.
 *
 * For details, see https://github.com/actions/runner/issues/904 and
 * https://java.testcontainers.org/supported_docker_environment/windows/#windows-container-on-windows-wcow
 *
 *
 */
export function osHasSupportedContainerRuntime() {
  return !isWindows() && !isMSeriesMac();
}
