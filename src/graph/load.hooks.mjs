// This hook is to ensure that @langchain/langgraph package
// found in /api folder has precendence compared to user-provided package
// found in /deps. Does not attempt to semver check for too old packages.
const OVERRIDE_RESOLVE = [
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint",
];

export async function resolve(specifier, context, nextResolve) {
  if (OVERRIDE_RESOLVE.includes(specifier)) {
    const parentURL = new URL("./load.mts", import.meta.url).toString();
    return await nextResolve(specifier, {
      ...context,
      parentURL,
    });
  }

  return nextResolve(specifier, context);
}
