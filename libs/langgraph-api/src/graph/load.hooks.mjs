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
  // HACK: @tailwindcss/node internally uses an ESM loader cache, which does not play nicely with `tsx`.
  //       Node.js crashes with "TypeError [ERR_INVALID_URL_SCHEME]: The URL must be of scheme file".
  //       As it already is a valid URI, we can just short-circuit the resolution and avoid `tsx`.
  if (
    specifier.includes("@tailwindcss/node/dist/esm-cache.loader.mjs") &&
    specifier.startsWith("file://")
  ) {
    return { shortCircuit: true, url: specifier, format: "module" };
  }

  if (OVERRIDE_RESOLVE.some((regex) => regex.test(specifier))) {
    return await nextResolve(specifier, { ...context, parentURL });
  }
  return nextResolve(specifier, context);
}
