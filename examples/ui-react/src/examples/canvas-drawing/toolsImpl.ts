import { z } from "zod/v4";

import {
  canvasGetInfo as canvasGetInfoHeadless,
  canvasClear as canvasClearHeadless,
  canvasSetStyle as canvasSetStyleHeadless,
  canvasDrawRect as canvasDrawRectHeadless,
  canvasDrawCircle as canvasDrawCircleHeadless,
  canvasDrawLine as canvasDrawLineHeadless,
  canvasDrawText as canvasDrawTextHeadless,
  canvasDrawPath as canvasDrawPathHeadless,
  canvasSaveRestore as canvasSaveRestoreHeadless,
  canvasTransform as canvasTransformHeadless,
  canvasSetGradient as canvasSetGradientHeadless,
  canvasDrawEllipse as canvasDrawEllipseHeadless,
  canvasDrawPolygon as canvasDrawPolygonHeadless,
  canvasSetLineDash as canvasSetLineDashHeadless,
  canvasSetBlendMode as canvasSetBlendModeHeadless,
  canvasSetFilter as canvasSetFilterHeadless,
  PathCommand,
} from "./tools";

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

export const canvasGetInfo = canvasGetInfoHeadless.implement(async () => {
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
});

export const canvasClear = canvasClearHeadless.implement(async ({ color }) => {
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
});

export const canvasSetStyle = canvasSetStyleHeadless.implement(
  async ({
    fillColor,
    strokeColor,
    lineWidth,
    font,
    globalAlpha,
    lineCap,
    lineJoin,
    shadowColor,
    shadowBlur,
    shadowOffsetX,
    shadowOffsetY,
  }) => {
    const c = ctx();
    if (fillColor !== undefined) c.fillStyle = fillColor;
    if (strokeColor !== undefined) c.strokeStyle = strokeColor;
    if (lineWidth !== undefined) c.lineWidth = lineWidth;
    if (font !== undefined) c.font = font;
    if (globalAlpha !== undefined)
      c.globalAlpha = Math.max(0, Math.min(1, globalAlpha));
    if (lineCap !== undefined) c.lineCap = lineCap as CanvasLineCap;
    if (lineJoin !== undefined) c.lineJoin = lineJoin as CanvasLineJoin;
    if (shadowColor !== undefined) c.shadowColor = shadowColor;
    if (shadowBlur !== undefined) c.shadowBlur = shadowBlur;
    if (shadowOffsetX !== undefined) c.shadowOffsetX = shadowOffsetX;
    if (shadowOffsetY !== undefined) c.shadowOffsetY = shadowOffsetY;
    return { success: true };
  }
);

export const canvasDrawRect = canvasDrawRectHeadless.implement(
  async ({
    x,
    y,
    width,
    height,
    fill = true,
    stroke = false,
    cornerRadius,
  }) => {
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
  }
);

export const canvasDrawCircle = canvasDrawCircleHeadless.implement(
  async ({
    cx,
    cy,
    radius,
    fill = true,
    stroke = false,
    startAngle = 0,
    endAngle = 360,
  }) => {
    const c = ctx();
    c.beginPath();
    c.arc(
      cx,
      cy,
      radius,
      (startAngle * Math.PI) / 180,
      (endAngle * Math.PI) / 180
    );
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  }
);

export const canvasDrawLine = canvasDrawLineHeadless.implement(
  async ({ x1, y1, x2, y2 }) => {
    const c = ctx();
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    return { success: true };
  }
);

export const canvasDrawText = canvasDrawTextHeadless.implement(
  async ({
    text,
    x,
    y,
    fill = true,
    stroke = false,
    maxWidth,
    align,
    baseline,
  }) => {
    const c = ctx();
    const prevAlign = c.textAlign;
    const prevBaseline = c.textBaseline;
    if (align) c.textAlign = align as CanvasTextAlign;
    if (baseline) c.textBaseline = baseline as CanvasTextBaseline;

    if (fill) {
      c.fillText(text, x, y, maxWidth)
    }
    if (stroke) {
      c.strokeText(text, x, y, maxWidth)
    }

    c.textAlign = prevAlign;
    c.textBaseline = prevBaseline;
    return { success: true };
  }
);

type PathCommandType = z.infer<typeof PathCommand>;
export const canvasDrawPath = canvasDrawPathHeadless.implement(
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
  }
);

export const canvasSaveRestore = canvasSaveRestoreHeadless.implement(
  async ({ action }) => {
    const c = ctx();
    if (action === "save") c.save();
    else c.restore();
    return { success: true };
  }
);

export const canvasTransform = canvasTransformHeadless.implement(
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
  }
);

export const canvasSetGradient = canvasSetGradientHeadless.implement(
  async ({ type, x0, y0, x1, y1, r0, r1, stops, target }) => {
    const c = ctx();
    let gradient: CanvasGradient;

    if (type === "linear") {
      gradient = c.createLinearGradient(x0, y0, x1 ?? x0, y1 ?? y0);
    } else {
      gradient = c.createRadialGradient(
        x0,
        y0,
        r0 ?? 0,
        x1 ?? x0,
        y1 ?? y0,
        r1 ?? 100
      );
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
  }
);

export const canvasDrawEllipse = canvasDrawEllipseHeadless.implement(
  async ({
    cx,
    cy,
    radiusX,
    radiusY,
    rotation = 0,
    fill = true,
    stroke = false,
    startAngle = 0,
    endAngle = 360,
  }) => {
    const c = ctx();
    c.beginPath();
    c.ellipse(
      cx,
      cy,
      radiusX,
      radiusY,
      (rotation * Math.PI) / 180,
      (startAngle * Math.PI) / 180,
      (endAngle * Math.PI) / 180
    );
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  }
);

export const canvasDrawPolygon = canvasDrawPolygonHeadless.implement(
  async ({
    cx,
    cy,
    outerRadius,
    sides,
    innerRadius,
    rotation = 0,
    fill = true,
    stroke = false,
  }) => {
    const c = ctx();
    const isStar = innerRadius !== undefined && innerRadius > 0;
    const points = isStar ? sides * 2 : sides;
    const rotRad = (rotation * Math.PI) / 180;

    c.beginPath();
    for (let i = 0; i < points; i++) {
      const angle = rotRad + (i * Math.PI * 2) / points - Math.PI / 2;
      const r = isStar && i % 2 === 1 ? (innerRadius as number) : outerRadius;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    if (fill) c.fill();
    if (stroke) c.stroke();
    return { success: true };
  }
);

export const canvasSetLineDash = canvasSetLineDashHeadless.implement(
  async ({ segments, offset = 0 }) => {
    const c = ctx();
    c.setLineDash(segments);
    c.lineDashOffset = offset;
    return { success: true };
  }
);

export const canvasSetBlendMode = canvasSetBlendModeHeadless.implement(
  async ({ mode }) => {
    const c = ctx();
    c.globalCompositeOperation = mode as GlobalCompositeOperation;
    return { success: true };
  }
);

export const canvasSetFilter = canvasSetFilterHeadless.implement(
  async ({ filter }) => {
    const c = ctx();
    c.filter = filter;
    return { success: true };
  }
);
