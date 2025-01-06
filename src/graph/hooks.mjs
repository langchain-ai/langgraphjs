// This hook is to ensure that @langchain/langgraph package
// found in /api folder has precendence compared to user-provided package
// found in /deps. Does not attempt to semver check for too old packages.
const OVERRIDE_RESOLVE = [
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint",
];

export const resolve = async (specifier, context, nextResolve) => {
  const parentURL = new URL("./graph.mts", import.meta.url).toString();

  if (OVERRIDE_RESOLVE.includes(specifier)) {
    return nextResolve(specifier, { ...context, parentURL });
  }

  return nextResolve(specifier, context);
};
