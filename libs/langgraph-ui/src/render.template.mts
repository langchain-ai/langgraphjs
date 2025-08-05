import type { ComponentClass, FunctionComponent } from "react";

const STORE_SYMBOL = Symbol.for("LGUI_EXT_STORE");

declare global {
  interface Window {
    [STORE_SYMBOL]: {
      respond: (
        shadowRootId: string,
        component: FunctionComponent | ComponentClass,
        renderEl: HTMLElement
      ) => void;
    };
  }
}

// @ts-ignore
function createRenderer(
  components: Record<string, FunctionComponent | ComponentClass>
) {
  return (name: string, shadowRootId: string) => {
    const root = document.getElementById(shadowRootId)!.shadowRoot;
    const renderEl = document.createElement("div");
    root!.appendChild(renderEl);
    window[STORE_SYMBOL].respond(shadowRootId, components[name], renderEl);
  };
}
