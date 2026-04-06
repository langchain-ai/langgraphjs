/**
 * Canvas Drawing Headless Tools
 *
 * Provides a structured, eval-free API for the LLM to draw on an HTML5 canvas.
 * Each tool maps to one or more safe Canvas 2D API calls — no arbitrary code
 * execution ever takes place.
 *
 * Usage:
 *  1. Mount a <canvas> element in your React component
 *  2. Call setCanvasContext(canvas.getContext("2d")) on mount
 *  3. Pass canvasToolImplementations to useStream's tools option
 */

import { tool } from "langchain";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Tool: get canvas info
// ---------------------------------------------------------------------------

export const canvasGetInfo = tool({
  name: "canvas_get_info",
  description:
    "Get the canvas dimensions (width × height in pixels) and the current " +
    "drawing styles. Call this first so you know the coordinate space.",
  schema: z.object({}),
});

// ---------------------------------------------------------------------------
// Tool: clear canvas
// ---------------------------------------------------------------------------
export const canvasClear = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: set drawing style
// ---------------------------------------------------------------------------
export const canvasSetStyle = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: draw rectangle
// ---------------------------------------------------------------------------
export const canvasDrawRect = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: draw circle / arc / ellipse
// ---------------------------------------------------------------------------
export const canvasDrawCircle = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: draw line
// ---------------------------------------------------------------------------
export const canvasDrawLine = tool({
  name: "canvas_draw_line",
  description:
    "Draw a straight line between two points using the current stroke style.",
  schema: z.object({
    x1: z.number().describe("Start X"),
    y1: z.number().describe("Start Y"),
    x2: z.number().describe("End X"),
    y2: z.number().describe("End Y"),
  }),
});

// ---------------------------------------------------------------------------
// Tool: draw text
// ---------------------------------------------------------------------------
export const canvasDrawText = tool({
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
      .enum(["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"])
      .optional()
      .describe("Vertical alignment relative to y"),
  }),
});

// ---------------------------------------------------------------------------
// Tool: draw complex path (polygons, curves, custom shapes)
// ---------------------------------------------------------------------------
export const PathCommand = z.union([
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

export const canvasDrawPath = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: save / restore context state
// ---------------------------------------------------------------------------
export const canvasSaveRestore = tool({
  name: "canvas_save_restore",
  description:
    "Push ('save') or pop ('restore') the drawing state stack. " +
    "Always save before applying transforms, then restore afterwards.",
  schema: z.object({
    action: z
      .enum(["save", "restore"])
      .describe(
        "'save' to push current state, 'restore' to pop previous state"
      ),
  }),
});

// ---------------------------------------------------------------------------
// Tool: transform coordinate system
// ---------------------------------------------------------------------------
export const canvasTransform = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: set linear gradient as fill / stroke
// ---------------------------------------------------------------------------
export const canvasSetGradient = tool({
  name: "canvas_set_gradient",
  description:
    "Create a linear or radial gradient and set it as the fill or stroke style. " +
    "For a linear gradient supply x0,y0 (start) and x1,y1 (end). " +
    "For a radial gradient supply x0,y0,r0 (inner circle) and x1,y1,r1 (outer circle). " +
    "Define colour stops as fractions from 0 to 1.",
  schema: z.object({
    type: z.enum(["linear", "radial"]).describe("Gradient type"),
    x0: z
      .number()
      .describe("Start X (linear) or inner circle centre X (radial)"),
    y0: z
      .number()
      .describe("Start Y (linear) or inner circle centre Y (radial)"),
    x1: z
      .number()
      .optional()
      .describe("End X (linear) or outer circle centre X (radial)"),
    y1: z
      .number()
      .optional()
      .describe("End Y (linear) or outer circle centre Y (radial)"),
    r0: z
      .number()
      .optional()
      .describe("Inner circle radius (radial only, default 0)"),
    r1: z
      .number()
      .optional()
      .describe("Outer circle radius (radial only, default 100)"),
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
});

// ---------------------------------------------------------------------------
// Tool: draw ellipse
// ---------------------------------------------------------------------------
export const canvasDrawEllipse = tool({
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
    startAngle: z
      .number()
      .optional()
      .describe("Start angle in degrees (default 0)"),
    endAngle: z
      .number()
      .optional()
      .describe("End angle in degrees (default 360 = full ellipse)"),
  }),
});

// ---------------------------------------------------------------------------
// Tool: draw regular polygon or star
// ---------------------------------------------------------------------------
export const canvasDrawPolygon = tool({
  name: "canvas_draw_polygon",
  description:
    "Draw a regular polygon (triangle, hexagon, octagon…) or a star. " +
    "For a polygon set `sides` and omit `innerRadius`. " +
    "For a star set `sides` (number of points) and `innerRadius` (inner notch radius). " +
    "Example: 5-pointed star → sides=5, outerRadius=80, innerRadius=35.",
  schema: z.object({
    cx: z.number().describe("Centre X"),
    cy: z.number().describe("Centre Y"),
    outerRadius: z
      .number()
      .describe("Outer radius (tip of each point / vertex)"),
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
});

// ---------------------------------------------------------------------------
// Tool: set line dash pattern
// ---------------------------------------------------------------------------
export const canvasSetLineDash = tool({
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
});

// ---------------------------------------------------------------------------
// Tool: set blend mode (globalCompositeOperation)
// ---------------------------------------------------------------------------
const BLEND_MODES = [
  "source-over",
  "source-in",
  "source-out",
  "source-atop",
  "destination-over",
  "destination-in",
  "destination-out",
  "destination-atop",
  "lighter",
  "copy",
  "xor",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export const canvasSetBlendMode = tool({
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
    mode: z.enum(BLEND_MODES).describe("Composite operation name"),
  }),
});

// ---------------------------------------------------------------------------
// Tool: apply CSS filter
// ---------------------------------------------------------------------------
export const canvasSetFilter = tool({
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
});
