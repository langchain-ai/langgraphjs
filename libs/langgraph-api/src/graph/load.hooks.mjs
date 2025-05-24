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
let langgraphPackageURL;

export async function initialize(args) {
  parentURL = args.parentURL;
}

export async function resolve(specifier, context, nextResolve) {
  // HACK: @tailwindcss/node internally uses an ESM loader cache, which does not play nicely with `tsx`.
  //       Node.js crashes with "TypeError [ERR_INVALID_URL_SCHEME]: The URL must be of scheme file".
  //       As it already is a valid URI, we can just short-circuit the resolution and avoid `tsx`.
  if (
    specifier.includes("@tailwindcss/node/dist/esm-cache.loader") &&
    specifier.startsWith("file://")
  ) {
    return {
      shortCircuit: true,
      // Node 18.x will for some reason attempt to load `.mts` instead of `.mjs`
      url: specifier.replace(".mts", ".mjs"),
      format: "module",
    };
  }

  if (specifier === "@langchain/langgraph-checkpoint") {
    // resolve relative to @langchain/langgraph package instead
    // This is done to avoid adding a direct dependency on @langchain/langgraph-checkpoint
    // in project, which if not present will cause `pnpm` to not find the package.
    if (!langgraphPackageURL) {
      const main = await nextResolve("@langchain/langgraph", {
        ...context,
        parentURL,
      });
      langgraphPackageURL = main.url.toString();
    }

    return await nextResolve(specifier, {
      ...context,
      parentURL: langgraphPackageURL,
    });
  }

  if (OVERRIDE_RESOLVE.some((regex) => regex.test(specifier))) {
    const resolved = await nextResolve(specifier, { ...context, parentURL });

    // If @langchain/langgraph is resolved first, cache it!
    if (specifier === "@langchain/langgraph" && !langgraphPackageURL) {
      langgraphPackageURL = resolved.url.toString();
    }
  }
  return nextResolve(specifier, context);
}
