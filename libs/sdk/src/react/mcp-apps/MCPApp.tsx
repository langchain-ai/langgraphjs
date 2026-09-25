/**
 * Render the MCP Apps in a LangGraph thread.
 *
 * Hand it what `useStream` returned and it renders the apps, if there are any.
 * There is no wrapper type to construct, no adapter to write, and no second
 * lookup to tell which tools ship a UI: the thread already contains that, and
 * finding it is this component's job rather than the caller's.
 *
 *     <MCPAppRenderer thread={thread} sandbox={{ url: SANDBOX }}
 *                     callTool={callTool} />
 *
 * Built on `@modelcontextprotocol/ext-apps`, the extension's official SDK, so
 * the wire format, version negotiation and the ordering rules are its problem.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpAppCall,
  McpAppResource,
  McpAppThread,
} from "../../ui/mcp-apps/bindings.js";
import { toolInputAction } from "../../ui/mcp-apps/ordering.js";
import { useMCPApps } from "./useMCPApps.js";

/** What the host will do on a view's behalf. A view can do nothing else. */
export interface McpAppHandlers {
  /**
   * Proxy a `tools/call`.
   *
   * SEP-1865 makes refusing a tool whose `visibility` omits `"app"` a MUST,
   * and the route behind this is where that happens. Never wire it straight
   * to an MCP client: the check has to sit somewhere the view cannot reach,
   * which a browser is not.
   *
   * `app` is the call whose view is asking. One set of handlers serves every
   * app a thread renders, and the spec scopes a view's calls to the server
   * that opened it, so without this a host with two servers cannot tell which
   * one to ask or which cross-server call to refuse.
   */
  callTool?: (params: {
    name: string;
    arguments: Record<string, unknown>;
    app: McpAppCall;
  }) => Promise<{ content?: unknown[]; structuredContent?: unknown }>;
  /**
   * Read a resource for the view, which has no origin and cannot fetch.
   *
   * `app` is the view asking, for the same reason as `callTool`.
   */
  readResource?: (params: {
    uri: string;
    app: McpAppCall;
  }) => Promise<unknown[]>;
  /** Open a link. Defaults to `window.open` for http and https only. */
  openLink?: (params: { url: string }) => Promise<void>;
  /** Put the view's text into the conversation. */
  onMessage?: (text: string) => void;
  /**
   * The view reported its content height.
   *
   * Take this when the surface owns the app's layout, which it usually does:
   * the ceiling on how tall an app may grow is a fact about the card it sits
   * in, not about the app. Handled internally when absent.
   */
  onResize?: (size: { height: number }) => void;
  /**
   * The view asked to be shown differently, and the host agreed.
   *
   * Only ever called with a mode the host declared in
   * `hostContext.availableDisplayModes`; a view asking for anything else is
   * refused before this. The host moves the frame, and the resulting mode is
   * returned to the view either way, which is what lets it rely on the answer
   * rather than guess.
   */
  onDisplayMode?: (mode: string) => void;
}

/** Everything an app needs that is the same for all of them. */
export interface McpAppConfig {
  /**
   * How the view is isolated. Two shapes, and the choice is a real one.
   *
   * `{ url }` is a sandbox proxy on a DIFFERENT ORIGIN than the host, which
   * is what SEP-1865 requires of a web host. The url is the proxy document's,
   * not any app's. The indirection is what lets a view hold
   * `allow-same-origin` without holding the host's origin, and it is the only
   * place the server's declared CSP can be applied.
   *
   * `{ direct: true }` renders the view straight into an iframe with
   * `allow-scripts` and never `allow-same-origin`, for a host that has only
   * one origin to serve from. That is a deviation from the spec and a
   * STRICTER one: the view gets an opaque origin, so no cookies, no storage,
   * no parent DOM and no network at all. What it costs is any app that
   * genuinely needs same-origin, for ES modules or storage, which will not
   * run. Prefer the proxy where a second origin exists.
   */
  sandbox:
    | {
        url: string | URL;
        /** The view's own sandbox attribute, applied by the proxy. */
        innerSandbox?: string;
        className?: string;
        style?: CSSProperties;
      }
    | { direct: true; className?: string; style?: CSSProperties };
  hostInfo?: { name: string; version: string };
  /** Merged into the context handed to every view. */
  hostContext?: Record<string, unknown>;
  /**
   * The tool's JSON Schema, for `hostContext.toolInfo.tool`.
   *
   * `Tool` declares `inputSchema` as required and the SDK validates the
   * initialize result, so leaving it out is not a cautious partial answer: an
   * app built on that SDK rejects the handshake outright. Absent, this sends
   * `{type: "object"}`, which is a valid empty object schema rather than an
   * invention, but a host that HAS the schema should pass it.
   */
  toolInputSchema?: Record<string, unknown>;
}

/** One app, placed wherever the conversation puts it. */
export interface MCPAppProps extends McpAppConfig, McpAppHandlers {
  /**
   * The call to draw.
   *
   * `useMCPApps(...).forCall(id)` returns one, and an `McpAppPart` is an
   * `McpAppCall`, so it passes straight in. A host with its own list builds
   * the smaller shape instead.
   */
  app: McpAppCall;
}

/**
 * Every call in a thread that shows an app, rendered together.
 *
 * The one-liner, for a host that has nowhere particular to put them. Anything
 * that interleaves apps with its own message components wants `useMCPApps`
 * and `MCPApp` instead, which is the same machinery without the placement.
 */
export interface MCPAppRendererProps extends McpAppConfig, McpAppHandlers {
  /** Straight from `useStream`. */
  thread: McpAppThread;
  /**
   * Which tool names ship a UI, and the `ui://` resource each opens.
   *
   * Only the thread-scanning form needs it: `MCPApp` is handed a call whose
   * app is already resolved. A host reads this once from the same route that
   * reads a resource and proxies a view's tool call.
   */
  apps: Record<string, McpAppResource>;
}

const DEFAULT_INNER_SANDBOX = "allow-scripts allow-forms";

/** Draw every call in the thread that shows an app. Nothing when there are none. */
export function MCPAppRenderer({
  thread,
  apps,
  ...config
}: MCPAppRendererProps) {
  const mcpApps = useMCPApps(thread, { apps });
  return (
    <>
      {mcpApps.all.map((part) => (
        <MCPApp key={part.toolCallId} app={part} {...config} />
      ))}
    </>
  );
}

export function MCPApp({
  app,
  sandbox,
  callTool,
  readResource,
  openLink,
  onMessage,
  onResize,
  onDisplayMode,
  hostInfo,
  hostContext,
  toolInputSchema,
}: MCPAppProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [bridge, setBridge] = useState<AppBridge | null>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(340);

  // The mode the view is actually in, which only the host changes.
  const mode = useRef("inline");
  const direct = "direct" in sandbox;
  const proxyUrl = direct ? null : String(sandbox.url);
  const innerSandbox = direct ? null : sandbox.innerSandbox;

  // Read at call time, not captured. A handler set or changed after the frame
  const live = useRef<McpAppHandlers>({});
  live.current = {
    callTool,
    readResource,
    openLink,
    onMessage,
    onResize,
    onDisplayMode,
  };

  // Read once, when the frame is built, so passing them inline (which every
  // caller does) does not rebuild the bridge on every render. A rebuilt
  // bridge tears down a handshake the iframe never repeats, and the app then
  // sits there talking to a host that has forgotten it.
  const config = useRef({ hostInfo, hostContext, toolInputSchema });
  config.current = { hostInfo, hostContext, toolInputSchema };

  // Read at call time too. The bridge is built once and the call changes under
  // it as the arguments stream, so a handler capturing the object would hand
  // the host a stale one.
  const current = useRef(app);
  current.current = app;

  /*
   * Effects here key on STRINGS, never on the objects around them.
   *
   * `thread` is a fresh object on every stream frame, so everything derived
   * from it is fresh too. An effect keyed on `app.resource` would tear the
   * bridge down and rebuild it several times a second, and the only visible
   * symptom is an app that never finishes its handshake.
   */
  const resource = app.resource;

  useEffect(() => {
    const win = frame.current?.contentWindow;
    if (!win) return;

    const appBridge = new AppBridge(
      // No MCP client. Given one the SDK forwards a view's calls automatically,
      // which applies none of the checks SEP-1865 requires, so the two proxied
      // methods arrive as handlers instead and the host answers them.
      null,
      config.current.hostInfo ?? { name: "langchain-host", version: "0.1.0" },
      {
        openLinks: {},
        logging: {},
        ...(live.current?.callTool ? { serverTools: {} } : {}),
        ...(live.current?.readResource ? { serverResources: {} } : {}),
      },
      {
        hostContext: {
          // A COMPLETE `Tool`. The SDK validates the initialize result and
          // `inputSchema` is required, so omitting it is not a cautious
          // partial answer: an app built on that SDK rejects the handshake.
          toolInfo: {
            tool: {
              name: app.toolName,
              inputSchema: config.current.toolInputSchema ?? { type: "object" },
            },
          },
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          ...config.current.hostContext,
        } as never,
      }
    );
    setBridge(appBridge);

    appBridge.onsizechange = ({ height: h }) => {
      if (typeof h !== "number") return;
      const report = live.current?.onResize;
      if (report) report({ height: h });
      else setHeight(Math.min(Math.max(h, 160), 900));
    };

    appBridge.oncalltool = async (params) => {
      const call = live.current?.callTool;
      if (!call) throw new Error("This host does not proxy tool calls.");
      const out = await call({
        name: String(params.name),
        arguments: (params.arguments ?? {}) as Record<string, unknown>,
        app: current.current,
      });
      return {
        content: (out.content ?? []) as never,
        structuredContent: out.structuredContent as never,
        isError: false,
      };
    };

    appBridge.onreadresource = async (params) => {
      const read = live.current?.readResource;
      if (!read) throw new Error("This host does not proxy resources/read.");
      return {
        contents: (await read({
          uri: String(params.uri),
          app: current.current,
        })) as never,
      };
    };

    appBridge.onopenlink = async (params) => {
      const url = String(params.url ?? "");
      const open = live.current?.openLink;
      if (open) return (await open({ url }), {});
      // `javascript:` would run in THIS page, which is the whole thing the
      // sandbox prevents, so only real links open.
      if (!/^https?:\/\//i.test(url))
        throw new Error("Only http and https links open.");
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };

    appBridge.onrequestdisplaymode = async (params) => {
      const wanted = String(params.mode ?? "");
      const offered = (config.current.hostContext
        ?.availableDisplayModes as string[]) ?? ["inline"];
      if (offered.includes(wanted)) {
        mode.current = wanted;
        live.current?.onDisplayMode?.(wanted);
      }

      return { mode: mode.current as "inline" | "fullscreen" | "pip" };
    };

    appBridge.onmessage = async (params) => {
      const push = live.current?.onMessage;
      if (!push)
        throw new Error("This host cannot accept a message right now.");
      const text = String(
        (params.content as { text?: string })?.text ?? ""
      ).trim();
      if (!text) throw new Error("ui/message needs content.text.");
      push(text);
      return {};
    };

    // Only in proxy mode. Rendering direct, the resource is already the
    // frame's `srcDoc` and there is no proxy to hand it to.
    appBridge.onsandboxready = () => {
      void appBridge.sendSandboxResourceReady({
        html: resource.html,
        sandbox: innerSandbox ?? DEFAULT_INNER_SANDBOX,
        csp: (resource.meta?.csp ?? undefined) as never,
        permissions: (resource.meta?.permissions ?? undefined) as never,
      });
    };

    // Registered BEFORE connect, deliberately. A view can send `initialized`
    // the moment the transport is attached, and a listener added in a later
    // effect would miss it and then wait forever for something already past.
    setReady(false);
    const onReady = () => setReady(true);
    appBridge.addEventListener("initialized", onReady);

    void appBridge.connect(new PostMessageTransport(win, win));
    return () => {
      // A request, not a notification: the spec has the host give the view a
      // chance to save what the person typed before the frame goes.
      appBridge.removeEventListener("initialized", onReady);
      void appBridge
        .teardownResource({ reason: "The app was closed." })
        .catch(() => {});
      setBridge(null);
      setReady(false);
    };
    // Deliberately not keyed on the input or the result. Those change on every
    // streamed frame, and rebuilding would tear down a handshake the iframe
    // never repeats: its resource does not reload, so the app would sit there
    // talking to a host that had forgotten it.
    // The resource's own fields are read here but MUST NOT be dependencies:
    // a new resource object on any frame would rebuild the bridge, and the
    // iframe never repeats its handshake, so the app would be left talking to
    // a host that had forgotten it. The uri and html below are the identity
    // that actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.uri, resource?.html, app.toolName, innerSandbox, proxyUrl]);

  // The host moved the app itself, so tell the view: it may have its own
  // chrome to put back. Declarative on purpose, so there is no imperative
  // handle to keep in sync with where the frame actually is.
  const wanted = (hostContext?.displayMode as string) ?? "inline";
  useEffect(() => {
    if (!bridge || wanted === mode.current) return;
    mode.current = wanted;
    void bridge.sendHostContextChange({
      displayMode: wanted as "inline" | "fullscreen" | "pip",
    });
  }, [bridge, wanted]);

  useToolInput(bridge, ready, app);

  const common = {
    ref: frame,
    title: `MCP app for ${app.toolName}`,
    "aria-label": app.resource.uri,
    className: sandbox.className,
    style: sandbox.style ?? { width: "100%", height, border: 0 },
  };

  // Direct: the view itself, with an opaque origin. `allow-same-origin` must
  // never appear here, because this frame is on the HOST's origin and adding
  // it would hand server-authored HTML the host's cookies and DOM.
  if (direct)
    return (
      <iframe {...common} srcDoc={resource.html} sandbox="allow-scripts" />
    );

  // Proxy: the PROXY's frame. The view is one further in, created by the
  // proxy on the proxy's origin, which is the point of the indirection.
  // `allow-scripts` with `allow-same-origin` normally defeats the sandbox,
  // because the frame can reach back into the page that embedded it. Here it
  // cannot: this frame is the sandbox PROXY, served from an origin that is
  // not the host's, so the origin it keeps is its own. That separation is
  // what SEP-1865 requires of a web host, and granting same-origin against
  // the proxy's origin is the entire reason the proxy exists. The view
  // itself, one frame further in, is sandboxed by the proxy.
  // oxlint-disable-next-line iframe-missing-sandbox
  return (
    <iframe
      {...common}
      src={proxyUrl!}
      sandbox="allow-scripts allow-same-origin allow-forms"
    />
  );
}

/**
 * Feed the call to the view as it arrives.
 *
 * SEP-1865 defines `tool-input-partial` so a
 * view can draw while the model is still writing the arguments, and a host
 * that only ever sends the final `tool-input` leaves the view blank until the
 * call is complete. LangGraph's messages stream parses partial JSON as it
 * goes, so the arguments really do arrive in pieces and there is something to
 * forward.
 *
 * The ordering the spec fixes and this keeps: zero or more partials, then
 * exactly one `tool-input`, then nothing. A run that finished between renders
 * still sends its one final input, so a view never waits on a partial that
 * already happened.
 */
function useToolInput(
  bridge: AppBridge | null,
  ready: boolean,
  app: McpAppCall
) {
  const sentFinal = useRef(false);
  const sentResult = useRef(false);

  useEffect(() => {
    sentFinal.current = false;
    sentResult.current = false;
  }, [bridge]);

  const input = JSON.stringify(app.input);
  useEffect(() => {
    if (!bridge || !ready) return;

    const action = toolInputAction({
      ready,
      sentFinal: sentFinal.current,
      streaming: app.streaming,
    });
    if (action === "partial") {
      void bridge.sendToolInputPartial({ arguments: app.input });
    } else if (action === "final") {
      // Exactly one, and nothing after it. A run that finished before the
      // view was ready still gets its final input, so a view never waits on a
      // partial that already happened.
      sentFinal.current = true;
      void bridge.sendToolInput({ arguments: app.input });
    }

    if (app.output && !sentResult.current) {
      sentResult.current = true;
      void bridge.sendToolResult(app.output as never);
    }
    // `ready` is load-bearing: `initialized` often arrives after the result
    // does, and without it this never re-runs to send anything.
    //
    // `app.input` is deliberately absent: it is a new object on every frame,
    // so depending on it would send a partial per render rather than per
    // actual change. `input` is its JSON, which changes only when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, ready, input, app.streaming, app.output]);
}
