/**
 * Canvas Drawing Browser Tools
 *
 * Provides a structured, eval-free API for the LLM to draw on an HTML5 canvas.
 * Each tool maps to one or more safe Canvas 2D API calls — no arbitrary code
 * execution ever takes place.
 *
 * Usage:
 *  1. Mount a <canvas> element in your React component
 *  2. Call setCanvasContext(canvas.getContext("2d")) on mount
 *  3. Pass canvasTools to useStream's browserTools option
 */

import { browserTool } from "langchain";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Shared canvas context reference (set by the React component on mount)
// ---------------------------------------------------------------------------

let canvasCtx: CanvasRenderingContext2D | null = null;
// Logical (CSS) pixel dimensions — independent of devicePixelRatio
let logicalWidth = 800;
let logicalHeight = 500;

/**
 * Call this from the React component when the canvas mounts / unmounts.
 * Pass the logical (CSS-pixel) width and height so canvas_get_info always
 * reports the coordinate space the LLM should use, not the physical backing
 * store size which may be 2× larger on HiDPI displays.
 */
export function setCanvasContext(
  ctx: CanvasRenderingContext2D | null,
  width = 800,
  height = 500
): void {
  canvasCtx = ctx;
  logicalWidth = width;
  logicalHeight = height;
}

function ctx(): CanvasRenderingContext2D {
  if (!canvasCtx) {
    throw new Error("Canvas is not ready — please wait for it to initialise.");
  }
  return canvasCtx;
}

// ---------------------------------------------------------------------------
// Tool: get canvas info
// ---------------------------------------------------------------------------

export const canvasGetInfo = browserTool(
  async () => {
    const c = ctx();
    return {
      success: true,
      // Always return LOGICAL (CSS-pixel) dimensions so the LLM uses the
      // correct coordinate space regardless of the device pixel ratio.
      width: logicalWidth,
      height: logicalHeight,
      fillStyle: String(c.fillStyle),
      strokeStyle: String(c.strokeStyle),
      lineWidth: c.lineWidth,
      font: c.font,
      globalAlpha: c.globalAlpha,
    };
  },
  {
    name: "canvas_get_info",
    description:
      "Get the canvas dimensions (width × height in pixels) and the current " +
      "drawing styles. Call this first so you know the coordinate space.",
    schema: z.object({}),
  }
);

// ---------------------------------------------------------------------------
// Tool: clear canvas
// ---------------------------------------------------------------------------

export const canvasClear = browserTool(
  async ({ color }) => {
    const c = ctx();
    if (color) {
      const prev = c.fillStyle;
      c.fillStyle = color;
      c.fillRect(0, 0, c.canvas.width, c.canvas.height);
      c.fillStyle = prev;
    } else {
      c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    }
    return {
      success: true,
      width: c.canvas.width,
      height: c.canvas.height,
      message: color
        ? `Canvas filled with ${color}`
        : "Canvas cleared to transparent",
    };
  },
  {
    name: "canvas_clear",
    description:
      "Clear the entire canvas. Optionally fill it with a solid background colour. " +
      "Always call this at the start of a drawing to get a clean slate.",
    schema: z.object({
      color: z
        .string()
        .optional()
        .describe(
          "CSS colour for the background (e.g. '#1a1a2e', 'white', 'rgb(30,30,60)'). " +
            "Omit to clear to fully transparent."
        ),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: set drawing style
// ---------------------------------------------------------------------------

export const canvasSetStyle = browserTool(
  async ({ fillColor, strokeColor, lineWidth, font, globalAlpha, lineCap, lineJoin, shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY }) => {
    const c = ctx();
    if (fillColor !== undefined) c.fillStyle = fillColor;
    if (strokeColor !== undefined) c.strokeStyle = strokeColor;
    if (lineWidth !== undefined) c.lineWidth = lineWidth;
    if (font !== undefined) c.font = font;
    if (globalAlpha !== undefined) c.globalAlpha = Math.max(0, Math.min(1, globalAlpha));
    if (lineCap !== undefined) c.lineCap = lineCap as CanvasLineCap;
    if (lineJoin !== undefined) c.lineJoin = lineJoin as CanvasLineJoin;
    if (shadowColor !== undefined) c.shadowColor = shadowColor;
    if (shadowBlur !== undefined) c.shadowBlur = shadowBlur;
    if (shadowOffsetX !== undefined) c.shadowOffsetX = shadowOffsetX;
    if (shadowOffsetY !== undefined) c.shadowOffsetY = shadowOffsetY;
    return { success: true };
  },
  {
    name: "canvas_set_style",
    description:
      "Set any combination of drawing styles: fill colour, stroke colour, line width, " +
      "font, opacity, line caps, and drop shadows. Call before drawing operations.",
    schema: z.object({
      fillColor: z
        .string()
        .optional()
        .describe(
          "Fill colour — any CSS colour: named ('red'), hex ('#ff6b6b'), " +
            "rgb('rgb(255,107,107)'), rgba('rgba(255,107,107,0.8)')"
        ),
      strokeColor: z
        .string()
        .optional()
        .describe("Stroke/outline colour — same formats as fillColor"),
      lineWidth: z.number().optional().describe("Stroke line width in pixels"),
      font: z
        .string()
        .optional()
        .describe(
          "CSS font string, e.g. 'bold 32px Arial', '20px Georgia', 'italic 18px serif'"
        ),
      globalAlpha: z
        .number()
        .optional()
        .describe("Overall opacity: 0 = transparent, 1 = fully opaque"),
      lineCap: z
        .enum(["butt", "round", "square"])
        .optional()
        .describe("Shape of line endpoints"),
      lineJoin: z
        .enum(["miter", "round", "bevel"])
        .optional()
        .describe("Shape of corners where lines meet"),
      shadowColor: z
        .string()
        .optional()
        .describe("Shadow colour (e.g. 'rgba(0,0,0,0.5)')"),
      shadowBlur: z.number().optional().describe("Shadow blur radius in pixels"),
      shadowOffsetX: z.number().optional().describe("Shadow X offset"),
      shadowOffsetY: z.number().optional().describe("Shadow Y offset"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw rectangle
// ---------------------------------------------------------------------------

export const canvasDrawRect = browserTool(
  async ({ x, y, width, height, fill = true, stroke = false, cornerRadius }) => {
    const c = ctx();
    c.beginPath();
    if (cornerRadius && cornerRadius > 0) {
      c.roundRect(x, y, width, height, cornerRadius);
    } else {
      c.rect(x, y, width, height);
    }
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  },
  {
    name: "canvas_draw_rect",
    description: "Draw a filled and/or outlined rectangle.",
    schema: z.object({
      x: z.number().describe("Left edge X coordinate (pixels from left)"),
      y: z.number().describe("Top edge Y coordinate (pixels from top)"),
      width: z.number().describe("Width in pixels"),
      height: z.number().describe("Height in pixels"),
      fill: z
        .boolean()
        .optional()
        .describe("Fill the rectangle with fillColor (default true)"),
      stroke: z
        .boolean()
        .optional()
        .describe("Outline the rectangle with strokeColor"),
      cornerRadius: z
        .number()
        .optional()
        .describe("Corner radius for rounded rectangles"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw circle / arc / ellipse
// ---------------------------------------------------------------------------

export const canvasDrawCircle = browserTool(
  async ({ cx, cy, radius, fill = true, stroke = false, startAngle = 0, endAngle = 360 }) => {
    const c = ctx();
    c.beginPath();
    c.arc(cx, cy, radius, (startAngle * Math.PI) / 180, (endAngle * Math.PI) / 180);
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  },
  {
    name: "canvas_draw_circle",
    description: "Draw a filled and/or outlined circle or arc.",
    schema: z.object({
      cx: z.number().describe("Centre X coordinate"),
      cy: z.number().describe("Centre Y coordinate"),
      radius: z.number().describe("Radius in pixels"),
      fill: z.boolean().optional().describe("Fill the circle (default true)"),
      stroke: z.boolean().optional().describe("Outline the circle"),
      startAngle: z
        .number()
        .optional()
        .describe("Start angle in degrees (0 = right, 90 = down). Default 0"),
      endAngle: z
        .number()
        .optional()
        .describe("End angle in degrees. Default 360 (full circle)"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw line
// ---------------------------------------------------------------------------

export const canvasDrawLine = browserTool(
  async ({ x1, y1, x2, y2 }) => {
    const c = ctx();
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    return { success: true };
  },
  {
    name: "canvas_draw_line",
    description: "Draw a straight line between two points using the current stroke style.",
    schema: z.object({
      x1: z.number().describe("Start X"),
      y1: z.number().describe("Start Y"),
      x2: z.number().describe("End X"),
      y2: z.number().describe("End Y"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw text
// ---------------------------------------------------------------------------

export const canvasDrawText = browserTool(
  async ({ text, x, y, fill = true, stroke = false, maxWidth, align, baseline }) => {
    const c = ctx();
    const prevAlign = c.textAlign;
    const prevBaseline = c.textBaseline;
    if (align) c.textAlign = align as CanvasTextAlign;
    if (baseline) c.textBaseline = baseline as CanvasTextBaseline;

    if (fill) {
      maxWidth !== undefined
        ? c.fillText(text, x, y, maxWidth)
        : c.fillText(text, x, y);
    }
    if (stroke) {
      maxWidth !== undefined
        ? c.strokeText(text, x, y, maxWidth)
        : c.strokeText(text, x, y);
    }

    c.textAlign = prevAlign;
    c.textBaseline = prevBaseline;
    return { success: true };
  },
  {
    name: "canvas_draw_text",
    description:
      "Draw text on the canvas. Set the font with canvas_set_style first.",
    schema: z.object({
      text: z.string().describe("The text to draw"),
      x: z.number().describe("X position"),
      y: z.number().describe("Y position"),
      fill: z.boolean().optional().describe("Fill the text (default true)"),
      stroke: z.boolean().optional().describe("Outline the text"),
      maxWidth: z
        .number()
        .optional()
        .describe("Maximum width — text is scaled to fit if wider"),
      align: z
        .enum(["left", "center", "right", "start", "end"])
        .optional()
        .describe("Horizontal alignment relative to x"),
      baseline: z
        .enum([
          "top",
          "hanging",
          "middle",
          "alphabetic",
          "ideographic",
          "bottom",
        ])
        .optional()
        .describe("Vertical alignment relative to y"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw complex path (polygons, curves, custom shapes)
// ---------------------------------------------------------------------------

const PathCommand = z.union([
  z.object({
    type: z.literal("moveTo"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("lineTo"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("quadraticCurveTo"),
    cpx: z.number(),
    cpy: z.number(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("bezierCurveTo"),
    cp1x: z.number(),
    cp1y: z.number(),
    cp2x: z.number(),
    cp2y: z.number(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("arc"),
    x: z.number(),
    y: z.number(),
    radius: z.number(),
    startAngle: z.number().describe("Degrees"),
    endAngle: z.number().describe("Degrees"),
    counterclockwise: z.boolean().optional(),
  }),
  z.object({ type: z.literal("closePath") }),
]);

type PathCommandType = z.infer<typeof PathCommand>;

export const canvasDrawPath = browserTool(
  async ({ commands, fill = false, stroke = true, close = false }) => {
    const c = ctx();
    c.beginPath();
    for (const cmd of commands as PathCommandType[]) {
      switch (cmd.type) {
        case "moveTo":
          c.moveTo(cmd.x, cmd.y);
          break;
        case "lineTo":
          c.lineTo(cmd.x, cmd.y);
          break;
        case "quadraticCurveTo":
          c.quadraticCurveTo(cmd.cpx, cmd.cpy, cmd.x, cmd.y);
          break;
        case "bezierCurveTo":
          c.bezierCurveTo(cmd.cp1x, cmd.cp1y, cmd.cp2x, cmd.cp2y, cmd.x, cmd.y);
          break;
        case "arc":
          c.arc(
            cmd.x,
            cmd.y,
            cmd.radius,
            (cmd.startAngle * Math.PI) / 180,
            (cmd.endAngle * Math.PI) / 180,
            cmd.counterclockwise ?? false
          );
          break;
        case "closePath":
          c.closePath();
          break;
      }
    }
    if (close) c.closePath();
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  },
  {
    name: "canvas_draw_path",
    description:
      "Draw a complex path using a sequence of commands: moveTo, lineTo, " +
      "quadraticCurveTo, bezierCurveTo, arc, closePath. Use for polygons, " +
      "stars, wave shapes, custom outlines, etc.",
    schema: z.object({
      commands: z
        .array(PathCommand)
        .describe("Ordered list of path commands to execute"),
      fill: z.boolean().optional().describe("Fill the path (default false)"),
      stroke: z
        .boolean()
        .optional()
        .describe("Stroke the path outline (default true)"),
      close: z
        .boolean()
        .optional()
        .describe(
          "Automatically close the path (connect last point to first) before painting"
        ),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: save / restore context state
// ---------------------------------------------------------------------------

export const canvasSaveRestore = browserTool(
  async ({ action }) => {
    const c = ctx();
    if (action === "save") c.save();
    else c.restore();
    return { success: true };
  },
  {
    name: "canvas_save_restore",
    description:
      "Push ('save') or pop ('restore') the drawing state stack. " +
      "Always save before applying transforms, then restore afterwards.",
    schema: z.object({
      action: z
        .enum(["save", "restore"])
        .describe("'save' to push current state, 'restore' to pop previous state"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: transform coordinate system
// ---------------------------------------------------------------------------

export const canvasTransform = browserTool(
  async ({ action, x, y, angle, scaleX, scaleY }) => {
    const c = ctx();
    switch (action) {
      case "translate":
        c.translate(x ?? 0, y ?? 0);
        break;
      case "rotate":
        c.rotate(((angle ?? 0) * Math.PI) / 180);
        break;
      case "scale":
        c.scale(scaleX ?? 1, scaleY ?? 1);
        break;
      case "reset":
        c.resetTransform();
        break;
    }
    return { success: true };
  },
  {
    name: "canvas_transform",
    description:
      "Move, rotate, or scale the canvas coordinate system. " +
      "Always call canvas_save_restore {action:'save'} first so you can undo it. " +
      "Use translate to reposition the origin, rotate for angled drawings, scale to resize.",
    schema: z.object({
      action: z
        .enum(["translate", "rotate", "scale", "reset"])
        .describe("Transformation to apply"),
      x: z.number().optional().describe("X offset (translate)"),
      y: z.number().optional().describe("Y offset (translate)"),
      angle: z.number().optional().describe("Angle in degrees (rotate)"),
      scaleX: z.number().optional().describe("X scale factor (scale)"),
      scaleY: z.number().optional().describe("Y scale factor (scale)"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: set linear gradient as fill / stroke
// ---------------------------------------------------------------------------

export const canvasSetGradient = browserTool(
  async ({ type, x0, y0, x1, y1, r0, r1, stops, target }) => {
    const c = ctx();
    let gradient: CanvasGradient;

    if (type === "linear") {
      gradient = c.createLinearGradient(x0, y0, x1 ?? x0, y1 ?? y0);
    } else {
      gradient = c.createRadialGradient(x0, y0, r0 ?? 0, x1 ?? x0, y1 ?? y0, r1 ?? 100);
    }

    for (const stop of stops) {
      gradient.addColorStop(stop.offset, stop.color);
    }

    if (target === "stroke") {
      c.strokeStyle = gradient;
    } else {
      c.fillStyle = gradient;
    }
    return { success: true };
  },
  {
    name: "canvas_set_gradient",
    description:
      "Create a linear or radial gradient and set it as the fill or stroke style. " +
      "For a linear gradient supply x0,y0 (start) and x1,y1 (end). " +
      "For a radial gradient supply x0,y0,r0 (inner circle) and x1,y1,r1 (outer circle). " +
      "Define colour stops as fractions from 0 to 1.",
    schema: z.object({
      type: z.enum(["linear", "radial"]).describe("Gradient type"),
      x0: z.number().describe("Start X (linear) or inner circle centre X (radial)"),
      y0: z.number().describe("Start Y (linear) or inner circle centre Y (radial)"),
      x1: z.number().optional().describe("End X (linear) or outer circle centre X (radial)"),
      y1: z.number().optional().describe("End Y (linear) or outer circle centre Y (radial)"),
      r0: z.number().optional().describe("Inner circle radius (radial only, default 0)"),
      r1: z.number().optional().describe("Outer circle radius (radial only, default 100)"),
      stops: z
        .array(
          z.object({
            offset: z.number().describe("Position from 0 (start) to 1 (end)"),
            color: z.string().describe("CSS colour at this stop"),
          })
        )
        .describe("At least two colour stops"),
      target: z
        .enum(["fill", "stroke"])
        .optional()
        .describe("Which style to set (default 'fill')"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw ellipse
// ---------------------------------------------------------------------------

export const canvasDrawEllipse = browserTool(
  async ({ cx, cy, radiusX, radiusY, rotation = 0, fill = true, stroke = false, startAngle = 0, endAngle = 360 }) => {
    const c = ctx();
    c.beginPath();
    c.ellipse(
      cx, cy, radiusX, radiusY,
      (rotation * Math.PI) / 180,
      (startAngle * Math.PI) / 180,
      (endAngle * Math.PI) / 180
    );
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  },
  {
    name: "canvas_draw_ellipse",
    description:
      "Draw a filled and/or outlined ellipse. Unlike canvas_draw_circle this supports " +
      "different horizontal and vertical radii and an optional rotation angle. " +
      "Use for eyes, eggs, planets, leaves, petals, wheels seen at an angle, etc.",
    schema: z.object({
      cx: z.number().describe("Centre X"),
      cy: z.number().describe("Centre Y"),
      radiusX: z.number().describe("Horizontal radius in pixels"),
      radiusY: z.number().describe("Vertical radius in pixels"),
      rotation: z
        .number()
        .optional()
        .describe("Rotation of the ellipse in degrees (default 0)"),
      fill: z.boolean().optional().describe("Fill the ellipse (default true)"),
      stroke: z.boolean().optional().describe("Outline the ellipse"),
      startAngle: z.number().optional().describe("Start angle in degrees (default 0)"),
      endAngle: z.number().optional().describe("End angle in degrees (default 360 = full ellipse)"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: draw regular polygon or star
// ---------------------------------------------------------------------------

export const canvasDrawPolygon = browserTool(
  async ({ cx, cy, outerRadius, sides, innerRadius, rotation = 0, fill = true, stroke = false }) => {
    const c = ctx();
    const isStar = innerRadius !== undefined && innerRadius > 0;
    const points = isStar ? sides * 2 : sides;
    const rotRad = (rotation * Math.PI) / 180;

    c.beginPath();
    for (let i = 0; i < points; i++) {
      const angle = rotRad + (i * Math.PI * 2) / points - Math.PI / 2;
      const r =
        isStar && i % 2 === 1 ? (innerRadius as number) : outerRadius;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  },
  {
    name: "canvas_draw_polygon",
    description:
      "Draw a regular polygon (triangle, hexagon, octagon…) or a star. " +
      "For a polygon set `sides` and omit `innerRadius`. " +
      "For a star set `sides` (number of points) and `innerRadius` (inner notch radius). " +
      "Example: 5-pointed star → sides=5, outerRadius=80, innerRadius=35.",
    schema: z.object({
      cx: z.number().describe("Centre X"),
      cy: z.number().describe("Centre Y"),
      outerRadius: z.number().describe("Outer radius (tip of each point / vertex)"),
      sides: z
        .number()
        .int()
        .describe("Number of sides for a polygon, or number of star points"),
      innerRadius: z
        .number()
        .optional()
        .describe(
          "Inner notch radius for a star shape. Omit for a regular polygon."
        ),
      rotation: z
        .number()
        .optional()
        .describe("Rotation offset in degrees (default 0)"),
      fill: z.boolean().optional().describe("Fill the shape (default true)"),
      stroke: z.boolean().optional().describe("Outline the shape"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: set line dash pattern
// ---------------------------------------------------------------------------

export const canvasSetLineDash = browserTool(
  async ({ segments, offset = 0 }) => {
    const c = ctx();
    c.setLineDash(segments);
    c.lineDashOffset = offset;
    return { success: true };
  },
  {
    name: "canvas_set_line_dash",
    description:
      "Set a dashed or dotted stroke pattern. " +
      "`segments` alternates between dash length and gap length in pixels. " +
      "Examples: [8,4] = 8px dash / 4px gap, [2,2] = dotted, [16,4,4,4] = dash-dot. " +
      "Pass an empty array [] to restore solid lines.",
    schema: z.object({
      segments: z
        .array(z.number())
        .describe(
          "Alternating dash and gap lengths in pixels. [] for solid lines."
        ),
      offset: z
        .number()
        .optional()
        .describe("Phase offset for the pattern (default 0)"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: set blend mode (globalCompositeOperation)
// ---------------------------------------------------------------------------

const BLEND_MODES = [
  "source-over", "source-in", "source-out", "source-atop",
  "destination-over", "destination-in", "destination-out", "destination-atop",
  "lighter", "copy", "xor",
  "multiply", "screen", "overlay",
  "darken", "lighten",
  "color-dodge", "color-burn",
  "hard-light", "soft-light",
  "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
] as const;

export const canvasSetBlendMode = browserTool(
  async ({ mode }) => {
    const c = ctx();
    c.globalCompositeOperation = mode as GlobalCompositeOperation;
    return { success: true };
  },
  {
    name: "canvas_set_blend_mode",
    description:
      "Set how new drawing operations blend with what is already on the canvas. " +
      "Creative uses: " +
      "'screen' for neon/glow (draw blurred bright shape, then screen blend for luminous effect); " +
      "'multiply' for shadows and ink-like depth; " +
      "'overlay' for contrast-boosting colour layers; " +
      "'lighten'/'darken' for atmospheric haze; " +
      "'difference' for psychedelic inversions. " +
      "Always reset to 'source-over' when done to avoid affecting later draws.",
    schema: z.object({
      mode: z
        .enum(BLEND_MODES)
        .describe("Composite operation name"),
    }),
  }
);

// ---------------------------------------------------------------------------
// Tool: apply CSS filter
// ---------------------------------------------------------------------------

export const canvasSetFilter = browserTool(
  async ({ filter }) => {
    const c = ctx();
    c.filter = filter;
    return { success: true };
  },
  {
    name: "canvas_set_filter",
    description:
      "Apply a CSS filter to all subsequent drawing operations. " +
      "Powerful creative uses: " +
      "'blur(8px)' to soften/feather edges or create glow halos (draw bright shape blurred, then sharp on top); " +
      "'brightness(1.5)' to make colours pop; " +
      "'contrast(2)' for graphic punch; " +
      "'hue-rotate(120deg)' to shift colours; " +
      "'saturate(3)' for vivid saturation; " +
      "'sepia(0.8)' for vintage tone; " +
      "Combine with spaces: 'blur(4px) brightness(1.3)'. " +
      "Pass 'none' to remove all filters.",
    schema: z.object({
      filter: z
        .string()
        .describe(
          "CSS filter string, e.g. 'blur(6px)', 'hue-rotate(90deg) saturate(2)', or 'none' to reset"
        ),
    }),
  }
);

// ---------------------------------------------------------------------------
// Exported collection
// ---------------------------------------------------------------------------

export const canvasTools = [
  canvasGetInfo,
  canvasClear,
  canvasSetStyle,
  canvasSetGradient,
  canvasSetLineDash,
  canvasSetBlendMode,
  canvasSetFilter,
  canvasDrawRect,
  canvasDrawCircle,
  canvasDrawEllipse,
  canvasDrawPolygon,
  canvasDrawLine,
  canvasDrawText,
  canvasDrawPath,
  canvasSaveRestore,
  canvasTransform,
];
