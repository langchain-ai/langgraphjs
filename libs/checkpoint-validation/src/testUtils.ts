// to make the type signature of the skipOnModules function a bit more readable
export type SaverName = string;
export type WhySkipped = string;

/**
 * Conditionally skips a test for a specific checkpoint saver implementation. When the test is skipped,
 * the reason for skipping is provided.
 *
 * @param saverName - The name of the current module being tested (as passed via the `name` argument in the top-level suite entrypoint).
 * @param skippedSavers - A list of modules for which the test should be skipped.
 * @returns A function that can be used in place of the Jest @see it function and conditionally skips the test for the provided module.
 */
export function it_skipForSomeModules(
  saverName: string,
  skippedSavers: Record<SaverName, WhySkipped>
): typeof it | typeof it.skip {
  const skipReason = skippedSavers[saverName];

  if (skipReason) {
    const skip = (
      name: string,
      test: jest.ProvidesCallback | undefined,
      timeout?: number
    ) => {
      it.skip(`[because ${skipReason}] ${name}`, test, timeout);
    };
    skip.prototype = it.skip.prototype;
    return skip as typeof it.skip;
  }

  return it;
}

export function it_skipIfNot(
  saverName: string,
  ...savers: SaverName[]
): typeof it | typeof it.skip {
  if (!savers.includes(saverName)) {
    const skip = (
      name: string,
      test: jest.ProvidesCallback | undefined,
      timeout?: number
    ) => {
      it.skip(
        `[only passes for "${savers.join('", "')}"] ${name}`,
        test,
        timeout
      );
    };
    skip.prototype = it.skip.prototype;
    return skip as typeof it.skip;
  }

  return it;
}
