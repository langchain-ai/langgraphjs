// This module hook is used to ensure that @langchain/langgraph package
// is imported from a consistent location.
// Accepts `{ parentURL: string }` as argument when registering the hook.
const OVERRIDE_RESOLVE = [
  // Override `@langchain/langgraph` or `@langchain/langgraph/prebuilt`,
  // but not `@langchain/langgraph-sdk`
  new RegExp(`^@langchain\/langgraph(\/.+)?$`),
  new RegExp(`^@langchain\/langgraph-checkpoint(\/.+)?$`),
];

let parentURL;

export async function initialize(args) {
  parentURL = args.parentURL;
}

export async function resolve(specifier, context, nextResolve) {
  if (OVERRIDE_RESOLVE.some((regex) => regex.test(specifier))) {
    return await nextResolve(specifier, { ...context, parentURL });
  }
  return nextResolve(specifier, context);
}
