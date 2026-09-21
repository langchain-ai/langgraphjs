/**
 * Shared diagnostics for the Docker CLI invocations made by `build`, `up` and
 * `deploy`.
 *
 * The `docker` binary is resolved from the inherited environment, exactly as
 * any other command a user runs in their shell. These helpers turn a failed
 * spawn into the same two-way distinction the Python CLI makes: the binary is
 * missing, or the daemon is not answering.
 */

export const DOCKER_NOT_INSTALLED =
  "Docker is required but not installed.\n" +
  "Install Docker Desktop: https://docs.docker.com/get-docker/";

export const DOCKER_NOT_RUNNING =
  "Docker is installed but not running.\nStart Docker and try again.";

/**
 * Whether a rejected (or `reject: false`) execa call failed because the binary
 * could not be found on `PATH`, as opposed to running and exiting non-zero.
 */
export function isBinaryNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
