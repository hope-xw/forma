import paper from "paper";
import svgpath from "svgpath";
import type { Operation } from "./commands";
import {
  type NodeStyle,
  nodeSchema,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { resolveNode } from "./design-system";
import { layoutBounds, type Point, type Rect } from "./geometry";
import { findLayer, isPublished } from "./scene-index";
import { roundedContour, strokeEdges } from "./stroke";
import { currentTextLayout, currentTextShape } from "./text-shape";
import { localTransform, transform } from "./transforms";
import { instanceOwner, isLocked } from "./tree";
import {
  hasVisibleVectorStroke,
  isDrawableContour,
  pathData,
  readContours,
  vectorBounds,
  type Contour,
  type EditablePath,
} from "./vector-path";

type Vector = NonNullable<DesignNode["vector"]>;
type Paint = Vector["paths"][number];
type OutlineResult = { operations: Operation[]; nodeId: string };
type StrokeOptions = Pick<Paint, "lineCap" | "lineJoin"> & {
  viewport?: Pick<Rect, "width" | "height">;
  miterLimit?: number;
  strokeDash?: string;
  strokeStyle?: NodeStyle["strokeStyle"];
};

let scope: paper.PaperScope | undefined;
function kernel() {
  if (!scope) {
    scope = new paper.PaperScope();
    scope.setup(new scope.Size(1, 1));
  }
  return scope;
}

// Flatten curves separately so original corners survive. Short tangent edges at
// either end keep butt/square caps and miter joins aligned to the actual cubic.
function centerline({ anchors, closed }: Contour, tolerance: number) {
  const api = kernel();
  const path = new api.Path({ insert: false });
  const add = (point: paper.Point) => {
    if (!path.lastSegment || !path.lastSegment.point.isClose(point, 1e-9))
      path.add(point);
  };
  add(new api.Point(anchors[0].x, anchors[0].y));
  for (let i = 0; i < anchors.length - (closed ? 0 : 1); i++) {
    const a = anchors[i],
      b = anchors[(i + 1) % anchors.length];
    const end = new api.Point(b.x, b.y);
    if (a.outgoing || b.incoming) {
      const arc = new api.Path({ insert: false });
      arc.moveTo(new api.Point(a.x, a.y));
      arc.cubicCurveTo(
        new api.Point(a.outgoing ?? a),
        new api.Point(b.incoming ?? b),
        end,
      );
      const curve = arc.firstCurve;
      const startTangent = curve.getTangentAtTime(0),
        endTangent = curve.getTangentAtTime(1);
      arc.flatten(tolerance);
      if (arc.segments.length > 2) {
        const segments = arc.segments;
        const start = segments[0].point;
        add(
          start.add(
            startTangent.normalize(start.getDistance(segments[1].point) / 4),
          ),
        );
        for (let j = 1; j < segments.length - 1; j++) add(segments[j].point);
        add(
          end.subtract(
            endTangent.normalize(
              end.getDistance(segments[segments.length - 2].point) / 4,
            ),
          ),
        );
      }
    }
    add(end);
  }
  if (
    closed &&
    path.segments.length > 1 &&
    path.firstSegment.point.isClose(path.lastSegment.point, 1e-9)
  )
    path.lastSegment.remove();
  path.closed = closed;
  return path;
}

function dashPattern(options: StrokeOptions, width: number) {
  const custom = options.strokeDash?.replace(
    /^[ \t\r\n\f]+|[ \t\r\n\f]+$/g,
    "",
  );
  if (custom === "none") return [];
  if (custom) {
    const values = custom
      .split(/[ \t\r\n\f]*,[ \t\r\n\f]*|[ \t\r\n\f]+/)
      .map((token) => {
        const match =
          /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(%|px)?$/i.exec(token);
        if (!match) throw Error("暂不支持此虚线间隔，请使用数值或百分比");
        let length = Number(match[1]);
        if (match[2] === "%") {
          if (!options.viewport) throw Error("百分比虚线间隔需要矢量视口尺寸");
          length *=
            Math.hypot(options.viewport.width, options.viewport.height) /
            (100 * Math.SQRT2);
        }
        if (!Number.isFinite(length) || length < 0)
          throw Error("虚线间隔必须为有限的非负长度");
        return length;
      });
    return values.some((n) => n > 0)
      ? values.length % 2
        ? [...values, ...values]
        : values
      : [];
  }
  if (options.strokeStyle === "dashed") return [3 * width, 2 * width];
  if (options.strokeStyle === "dotted") return [0, 2 * width];
  return [];
}

// Walk the flattened edges by arc length. Keep vertices inside each dash so
// corners get joins, including a dash spanning the seam of a closed contour.
function dashSegments(path: paper.Path, pattern: number[]): paper.Path[] {
  if (!pattern.length || !path.length) return [path];
  const period = pattern.reduce((a, b) => a + b, 0);
  if ((path.length / period) * pattern.length > 20000)
    throw Error("虚线轮廓超出路径容量，请先分段处理");
  const points = path.segments.map((s) => s.point);
  if (path.closed) points.push(points[0]);
  const runs: paper.Point[][] = [];
  let index = 0,
    remaining = pattern[0],
    current: paper.Point[] | undefined;
  const advance = () => {
    index = (index + 1) % pattern.length;
    remaining = pattern[index];
    if (index % 2 && remaining) current = undefined;
  };
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1],
      end = points[i];
    const edge = end.subtract(start),
      length = edge.length;
    let offset = 0;
    while (offset < length) {
      const step = Math.min(remaining, length - offset);
      if (index % 2 === 0) {
        if (!current) {
          current = [start.add(edge.multiply(offset / length))];
          runs.push(current);
        }
        if (step)
          current.push(start.add(edge.multiply((offset + step) / length)));
      }
      offset += step;
      remaining -= step;
      if (remaining === 0) advance();
    }
  }
  // A zero-length final dash still paints a cap at an open endpoint.
  if (!path.closed && !current && index % 2 === 0 && remaining === 0)
    runs.push([points[points.length - 1]]);
  const first = runs[0],
    last = runs.at(-1);
  if (
    path.closed &&
    first &&
    last &&
    first[0].isClose(last[last.length - 1], 1e-8)
  ) {
    if (first === last) {
      if (first.length > 1) return [path];
    } else {
      first.unshift(...last.slice(0, -1));
      runs.pop();
    }
  }
  const api = kernel();
  return runs.map((segments) => new api.Path({ segments, insert: false }));
}

export function outlineStrokePath(
  d: string,
  width: number,
  options: StrokeOptions = {},
): string {
  if (!(width > 0) || !Number.isFinite(width)) return "";
  let pieces: paper.PathItem[] = [];
  const pattern = dashPattern(options, width);
  for (const contour of readContours(d)) {
    if (!isDrawableContour(contour)) continue;
    const line = centerline(contour, Math.min(0.05, width / 100));
    for (const path of dashSegments(line, pattern)) {
      // Paper sweeps both offset strips, joins the corners and caps, and unites
      // their areas. Overlaps are painted once and closed contours retain holes.
      const piece = path.outline({
        width,
        cap:
          options.strokeStyle === "dotted"
            ? "round"
            : (options.lineCap ?? "round"),
        join: options.lineJoin ?? "round",
        miterLimit: Math.max(1, options.miterLimit ?? 4),
        insert: false,
      });
      if (!piece.isEmpty()) pieces.push(piece);
    }
  }
  // Batch unions so a long dashed contour does not repeatedly intersect every
  // new dash against the growing compound path.
  while (pieces.length > 1) {
    const pairs: paper.PathItem[] = [];
    for (let i = 0; i < pieces.length; i += 2) {
      const next = pieces[i + 1];
      pairs.push(next ? pieces[i].unite(next, { insert: false }) : pieces[i]);
    }
    pieces = pairs;
  }
  return pieces[0]?.pathData ?? "";
}

function editableNode(doc: DesignDocument, id: string) {
  const raw = findLayer(doc, id);
  return raw && !isLocked(doc, id) && !instanceOwner(doc, id) ? raw : undefined;
}

const unsupportedPaint =
  "暂不支持对图片、渐变或多重叠加填充/描边图层直接轮廓化，请先转为纯色填充或纯描边";
const unsupportedBindings =
  "填充和描边的独立样式绑定无法同时保留，请先简化画笔";
const noVisibleStroke =
  "请选择有可见描边且可编辑的图层，锁定图层或组件实例不能转为轮廓";
const unsupportedText =
  "暂不支持将含多字体/省略截断/双向混排的文本直接转为轮廓，请先简化排版";
const protectedText =
  "请选择非空且可编辑的文字，锁定图层或组件实例不能转为轮廓";
const visible = (color: string | undefined, opacity = 1) =>
  color !== "transparent" && opacity > 0;
const widthsFor = (s: NodeStyle) =>
  strokeEdges.map((e) => s.strokeSides?.[e] ?? s.strokeWidth ?? 0);
const liveFill = (n: DesignNode) =>
  !!(
    ((n.style.fillOpacity ?? 1) > 0 &&
      (n.fillToken || n.variableBindings?.fill)) ||
    n.variableBindings?.fillOpacity ||
    n.styleBindings?.paint
  );
const liveStroke = (n: DesignNode) =>
  !!(
    n.variableBindings?.stroke ||
    n.variableBindings?.strokeOpacity ||
    (!n.style.stroke && n.variableBindings?.color)
  );

function viewport(source: Vector, rect: Rect) {
  const w = rect.width || source.width,
    h = rect.height || source.height;
  const scale = Math.min(w / source.width, h / source.height);
  const sx = source.stretch ? w / source.width : scale,
    sy = source.stretch ? h / source.height : scale;
  return {
    w,
    h,
    sx,
    sy,
    x: (w - source.width * sx) / 2,
    y: (h - source.height * sy) / 2,
  };
}

type StrokeWindow = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
const unbounded: StrokeWindow = {
  left: -Infinity,
  top: -Infinity,
  right: Infinity,
  bottom: Infinity,
};
const pathArity: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

type StrokeExtent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
type PathScanSummary = StrokeExtent & {
  hasDrawable: boolean;
  hasNonDegenerateButt: boolean;
  segments: StrokeExtent[];
  capDots: StrokeExtent[];
};

function overlapsWindow(s: StrokeExtent, bounds: StrokeWindow) {
  return (
    s.maxX >= bounds.left &&
    s.minX <= bounds.right &&
    s.maxY >= bounds.top &&
    s.minY <= bounds.bottom
  );
}

function summaryHits(
  summary: PathScanSummary,
  butt: boolean,
  bounds: StrokeWindow,
) {
  if (
    !(butt ? summary.hasNonDegenerateButt : summary.hasDrawable) ||
    !overlapsWindow(summary, bounds)
  )
    return false;
  // A move or a zero-length cap can leave a gap inside the overall bounds.
  const hits = (s: StrokeExtent) => overlapsWindow(s, bounds);
  return summary.segments.some(hits) || (!butt && summary.capDots.some(hits));
}

function includeExtent(target: StrokeExtent, extent: StrokeExtent) {
  target.minX = Math.min(target.minX, extent.minX);
  target.maxX = Math.max(target.maxX, extent.maxX);
  target.minY = Math.min(target.minY, extent.minY);
  target.maxY = Math.max(target.maxY, extent.maxY);
}

const maxStrokeSpans = 32;
function addStrokeExtent(
  summary: PathScanSummary,
  nonDegenerate: boolean,
  extent: StrokeExtent,
) {
  summary.hasDrawable = true;
  summary.hasNonDegenerateButt ||= nonDegenerate;
  const spans = nonDegenerate ? summary.segments : summary.capDots;
  const last = spans[spans.length - 1];
  // Keep gaps between segment hulls where possible. Bound the detail retained
  // per path so neither memory nor a resize query scales with its command count.
  if (
    last &&
    (spans.length >= maxStrokeSpans ||
      (last.minY === extent.minY &&
        last.maxY === extent.maxY &&
        extent.minX <= last.maxX &&
        last.minX <= extent.maxX) ||
      (last.minX === extent.minX &&
        last.maxX === extent.maxX &&
        extent.minY <= last.maxY &&
        last.minY <= extent.maxY))
  ) {
    includeExtent(last, extent);
  } else spans.push(extent);
}

function arcExtent(
  cx: number,
  cy: number,
  x: number,
  y: number,
  rx: number,
  ry: number,
  large: boolean,
  sweep: boolean,
) {
  const moved = x !== cx || y !== cy;
  let minX = Math.min(cx, x),
    maxX = Math.max(cx, x);
  let minY = Math.min(cy, y),
    maxY = Math.max(cy, y);
  if (moved && rx && ry) {
    // SVG scales undersized radii by the half-chord length in unit-circle
    // space. L1 chord / minor radius bounds the normalized chord at every
    // rotation. Every point is within one corrected diameter of both ends.
    const major = Math.max(rx, ry),
      minor = Math.min(rx, ry);
    const chordBound = major * ((Math.abs(x - cx) + Math.abs(y - cy)) / minor);
    if (large) {
      const diameter = Math.max(2 * major, chordBound);
      minX = Math.max(cx, x) - diameter;
      maxX = Math.min(cx, x) + diameter;
      minY = Math.max(cy, y) - diameter;
      maxY = Math.min(cy, y) + diameter;
    } else {
      // In unit-circle space a minor arc lies inside the disk whose
      // diameter is the chord. Transform that disk back about its midpoint.
      const midX = cx + (x - cx) / 2,
        midY = cy + (y - cy) / 2;
      minX = midX - chordBound / 2;
      maxX = midX + chordBound / 2;
      minY = midY - chordBound / 2;
      maxY = midY + chordBound / 2;
    }
    // A convex arc stays on the sweep side of its endpoint chord.
    if (cx === x) {
      if (y > cy === sweep) minX = x;
      else maxX = x;
    }
    if (cy === y) {
      if (x > cx === sweep) maxY = y;
      else minY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function digit(code: number) {
  return code >= 48 && code <= 57;
}

function unicodeSpace(code: number) {
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

// Compare repetitions of a parsed arc in place. A space and a comma each
// separate two numeric tokens. Other whitespace and compact flags match exactly.
function repeatedArcs(d: string, start: number, end: number) {
  const length = end - start;
  let cursor = end;
  while (cursor < d.length) {
    const expected = d.charCodeAt(cursor - length),
      actual = d.charCodeAt(cursor);
    if (actual !== expected) {
      if (!(
        (actual === 32 && expected === 44) ||
        (actual === 44 && expected === 32)
      ))
        break;
      const before = d.charCodeAt(cursor - 1),
        after = d.charCodeAt(cursor + 1);
      if (
        !(digit(before) || before === 46) ||
        !(digit(after) || after === 46 || after === 43 || after === 45)
      )
        break;
    }
    cursor++;
  }
  // Leave a partial final coordinate (e.g. a longer exponent) for readNumber.
  let copies = Math.floor((cursor - end) / length);
  const next = d.charCodeAt(end + copies * length);
  if (copies && (digit(next) || next === 46 || next === 69 || next === 101))
    copies--;
  return copies;
}

function addRepeatedArcs(
  summary: PathScanSummary,
  args: number[],
  x: number,
  y: number,
  count: number,
) {
  const rx = Math.abs(args[0]),
    ry = Math.abs(args[1]);
  const large = args[3] === 1,
    sweep = args[4] === 1;
  const dx = args[5],
    dy = args[6];
  const detailed = Math.min(count, maxStrokeSpans);
  for (let i = 0; i < detailed; i++) {
    const endX = x + dx,
      endY = y + dy;
    addStrokeExtent(
      summary,
      x !== endX || y !== endY,
      arcExtent(x, y, endX, endY, rx, ry, large, sweep),
    );
    x = endX;
    y = endY;
  }
  // Equal relative steps are monotone on each axis. Bound the tail by its
  // endpoints and the largest radius correction, preserving SVG accumulation.
  const startX = x,
    startY = y;
  let longestChord = 0;
  for (let i = detailed; i < count; i++) {
    const endX = x + dx,
      endY = y + dy;
    longestChord = Math.max(
      longestChord,
      Math.abs(endX - x) + Math.abs(endY - y),
    );
    x = endX;
    y = endY;
  }
  if (longestChord) {
    const major = Math.max(rx, ry),
      minor = Math.min(rx, ry);
    const chordBound = minor ? major * (longestChord / minor) : 0;
    const pad = !minor
      ? 0
      : large
        ? Math.max(2 * major, chordBound)
        : chordBound / 2;
    addStrokeExtent(summary, true, {
      minX: Math.min(startX, x) - pad,
      minY: Math.min(startY, y) - pad,
      maxX: Math.max(startX, x) + pad,
      maxY: Math.max(startY, y) + pad,
    });
  }
  return { x, y };
}

// Stream parameter groups so a visible first segment never parses the tail.
function scanStroke(
  d: string,
  butt: boolean,
  bounds: StrokeWindow,
): true | PathScanSummary {
  let pos = 0,
    command = "",
    previous = "",
    relative = false;
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0,
    controlX = 0,
    controlY = 0;
  const args: number[] = [];
  const summary: PathScanSummary = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    hasDrawable: false,
    hasNonDegenerateButt: false,
    segments: [],
    capDots: [],
  };
  function skipSpace() {
    let code = d.charCodeAt(pos);
    while (
      code === 32 ||
      (code >= 9 && code <= 13) ||
      (code > 127 && unicodeSpace(code))
    )
      code = d.charCodeAt(++pos);
  }
  function skipCommaSpace() {
    skipSpace();
    if (d.charCodeAt(pos) === 44) {
      pos++;
      skipSpace();
    }
  }
  function readNumber() {
    const start = pos;
    let code = d.charCodeAt(pos);
    const negative = code === 45;
    if (negative || code === 43) code = d.charCodeAt(++pos);
    let value = 0;
    const whole = pos;
    while (digit(code)) {
      value = value * 10 + (code - 48);
      code = d.charCodeAt(++pos);
    }
    if (code === 46) {
      code = d.charCodeAt(++pos);
      if (pos === whole + 1 && !digit(code)) return NaN;
      let fraction = 0,
        divisor = 1,
        scale = 1;
      while (digit(code)) {
        fraction = fraction * 10 + (code - 48);
        divisor *= 10;
        // Flush long fractions in exact integer chunks.
        if (divisor === 1e15) {
          value += (fraction / divisor) * scale;
          scale /= divisor;
          fraction = 0;
          divisor = 1;
        }
        code = d.charCodeAt(++pos);
      }
      value += (fraction / divisor) * scale;
    } else if (whole === pos) return NaN;
    if (code === 101 || code === 69) {
      let end = pos + 1;
      code = d.charCodeAt(end);
      if (code === 43 || code === 45) code = d.charCodeAt(++end);
      if (digit(code)) {
        do end++;
        while (digit(d.charCodeAt(end)));
        pos = end;
        return Number(d.slice(start, end));
      }
    }
    return negative ? -value : value;
  }
  function readFlag() {
    const flag = d.charCodeAt(pos) - 48;
    if (flag !== 0 && flag !== 1) return NaN;
    pos++;
    return flag;
  }
  skipSpace();
  while (pos < d.length) {
    const start = pos;
    const letter = d[pos],
      upper = letter.toUpperCase();
    const explicit = Object.hasOwn(pathArity, upper);
    if (explicit) {
      command = upper;
      relative = letter !== upper;
      pos++;
      skipSpace();
    } else if (!command || command === "Z") return summary;
    if (!previous && command !== "M") return summary;
    const arity = pathArity[command];
    for (let i = 0; i < arity; i++) {
      if (!explicit || i > 0) skipCommaSpace();
      args[i] =
        command === "A" && (i === 3 || i === 4) ? readFlag() : readNumber();
      if (!Number.isFinite(args[i])) return summary;
    }
    skipSpace();
    const dx = relative ? cx : 0,
      dy = relative ? cy : 0;
    let x = cx,
      y = cy;
    if (command === "Z") {
      x = sx;
      y = sy;
    } else if (command === "H") x = args[0] + dx;
    else if (command === "V") y = args[0] + dy;
    else {
      x = args[arity - 2] + dx;
      y = args[arity - 1] + dy;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return summary;
    if (command === "M") {
      cx = sx = x;
      cy = sy = y;
      previous = "M";
      command = "L";
      continue;
    }

    let x1 = cx,
      y1 = cy,
      x2 = x,
      y2 = y;
    if (command === "C" || command === "Q") {
      x1 = args[0] + dx;
      y1 = args[1] + dy;
    } else if (
      (command === "S" && (previous === "C" || previous === "S")) ||
      (command === "T" && (previous === "Q" || previous === "T"))
    ) {
      x1 = 2 * cx - controlX;
      y1 = 2 * cy - controlY;
    }
    if (command === "C" || command === "S") {
      controlX = x2 = args[arity - 4] + dx;
      controlY = y2 = args[arity - 3] + dy;
    } else {
      controlX = x1;
      controlY = y1;
    }
    const moved =
      cx !== x || cy !== y || cx !== x1 || cy !== y1 || cx !== x2 || cy !== y2;
    if (moved || command !== "Z") {
      const hull =
        command === "A"
          ? arcExtent(
              cx,
              cy,
              x,
              y,
              Math.abs(args[0]),
              Math.abs(args[1]),
              args[3] === 1,
              args[4] === 1,
            )
          : {
              minX: Math.min(cx, x1, x2, x),
              minY: Math.min(cy, y1, y2, y),
              maxX: Math.max(cx, x1, x2, x),
              maxY: Math.max(cy, y1, y2, y),
            };
      if (
        !summary.hasDrawable &&
        (moved || !butt) &&
        overlapsWindow(hull, bounds)
      )
        return true;
      addStrokeExtent(summary, moved, hull);
    }
    if (letter === "a" && moved) {
      const copies = repeatedArcs(d, start, pos);
      if (copies) {
        pos += copies * (pos - start);
        ({ x, y } = addRepeatedArcs(summary, args, x, y, copies));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return summary;
      }
    }
    cx = x;
    cy = y;
    previous = command;
  }
  return summary;
}

// Geometry survives viewport, cap and document revisions. Only completed
// scans enter the LRU; a streamed hit has no bounds for the remaining tail.
const strokeScans = new Map<string, PathScanSummary>();
function strokeHits(d: string, butt: boolean, bounds: StrokeWindow) {
  let summary = strokeScans.get(d);
  if (summary) strokeScans.delete(d);
  else {
    const scan = scanStroke(d, butt, bounds);
    if (scan === true) return true;
    summary = scan;
    for (const span of summary.segments) includeExtent(summary, span);
    for (const dot of summary.capDots) includeExtent(summary, dot);
    if (strokeScans.size >= 4096)
      strokeScans.delete(strokeScans.keys().next().value!);
  }
  strokeScans.set(d, summary);
  return summaryHits(summary, butt, bounds);
}

// Inspector preflight only reads path geometry. Expansion and clipping belong to the command.
function drawableStroke(
  n: DesignNode,
  path: Paint,
  pattern: number[],
  rect?: Rect,
) {
  if (!hasVisibleVectorStroke(n, path)) return false;
  if (
    path.lineCap === "butt" &&
    n.style.strokeStyle !== "dotted" &&
    pattern.length &&
    !pattern.some((length, i) => !(i % 2) && length > 0)
  )
    return false;
  const butt = path.lineCap === "butt" && n.style.strokeStyle !== "dotted";
  const v = n.vector!;
  if (v.overflowVisible && !n.style.clipContent)
    return strokeHits(path.d, butt, unbounded);
  // Responsive letterboxing is only known when the command resolves layout.
  if (
    !rect &&
    !v.stretch &&
    (n.style.widthMode === "fill" ||
      n.style.heightMode === "fill" ||
      n.style.constraintX ||
      n.style.constraintY ||
      n.style.minWidth ||
      n.style.maxWidth ||
      n.style.minHeight ||
      n.style.maxHeight)
  )
    return strokeHits(path.d, butt, unbounded);
  const { w, h, sx, sy, x, y } = viewport(v, rect ?? n.style);
  // A cubic lies inside its controls' convex hull. This cheap separating-axis
  // check can reject offscreen paths without solving curve extrema or stroking.
  const outset =
    path.strokeWidth *
    (path.lineJoin === "miter"
      ? 2
      : path.lineCap === "square"
        ? Math.SQRT1_2
        : 0.5);
  const left = -x / sx - outset,
    right = (w - x) / sx + outset;
  const top = -y / sy - outset,
    bottom = (h - y) / sy + outset;
  return strokeHits(path.d, butt, { left, right, top, bottom });
}

function strokeProblem(doc: DesignDocument, n?: DesignNode, rect?: Rect) {
  if (n && ["rectangle", "ellipse", "vector"].includes(n.type)) {
    const s = n.style;
    if (s.strokeVisible === false || s.opacity === 0) return noVisibleStroke;
    if (
      s.sketchCanvasPaints?.length ||
      s.sketchSymbolBackground ||
      s.tint ||
      s.figmaGlass ||
      s.sketchGlass ||
      (n.type !== "vector" && s.blendMode === "plus-darker")
    )
      return "暂不支持对含画布专属样式的导入图层直接轮廓化";
    if (
      n.image ||
      s.gradient ||
      s.paints?.length ||
      s.strokePaints?.length ||
      [s.fillBlendMode, s.strokeBlendMode].some(
        (mode) => mode && mode !== "normal" && mode !== "pass-through",
      )
    )
      return unsupportedPaint;
    const dashOptions = { ...s, viewport: n.vector ?? rect ?? s };
    if (n.type === "vector") {
      const currentColorIsLive =
        n.variableBindings?.color ||
        n.variableBindings?.colorOpacity ||
        n.styleBindings?.text ||
        n.styleBindings?.paint;
      if (
        n.vector?.paths.some(
          (p) =>
            hasVisibleVectorStroke(n, p) &&
            !p.strokeColor &&
            ((n.vector?.fillFromStyle && currentColorIsLive) ||
              (p.fill &&
                (p.opacity ?? 1) < 1 &&
                (n.variableBindings?.colorOpacity ||
                  n.styleBindings?.text ||
                  n.styleBindings?.paint))),
        )
      )
        return unsupportedBindings;
      if (
        n.vector?.paths.some((p) =>
          drawableStroke(n, p, dashPattern(dashOptions, p.strokeWidth), rect),
        )
      )
        return;
    } else {
      const cannotBind = (
        token: string | undefined,
        property: "color" | "colorOpacity",
      ) => {
        const scopes = token && doc.designSystem?.variables[token]?.scopes;
        return scopes && scopes.length && !scopes.includes(property);
      };
      if (
        n.styleBindings?.stroke ||
        (liveStroke(n) && liveFill(n)) ||
        cannotBind(n.variableBindings?.stroke, "color") ||
        cannotBind(n.variableBindings?.strokeOpacity, "colorOpacity")
      )
        return unsupportedBindings;
      if (
        visible(s.stroke ?? s.color, s.strokeOpacity) &&
        widthsFor(s).some((w) => {
          if (!w) return false;
          const dash = dashPattern(dashOptions, w);
          return (
            !dash.length ||
            s.strokeStyle === "dotted" ||
            dash.some((length, i) => i % 2 === 0 && length > 0)
          );
        })
      )
        return;
    }
  }
  return noVisibleStroke;
}
const strokeAvailability = new WeakMap<DesignDocument, Map<string, boolean>>();
export function canOutlineStroke(doc: DesignDocument, nodeId: string): boolean {
  // Published editor documents are immutable. Draft/import callers can still edit in place.
  let cache = strokeAvailability.get(doc);
  if (!cache && isPublished(doc))
    strokeAvailability.set(doc, (cache = new Map()));
  const cached = cache?.get(nodeId);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    const n = editableNode(doc, nodeId);
    available = !strokeProblem(doc, n && resolveNode(doc, n));
  } catch {
    // Unsupported dash syntax or invalid source geometry disables the action.
  }
  cache?.set(nodeId, available);
  return available;
}

// Unicode 17.0, extracted/DerivedBidiClass.txt (including @missing defaults).
// JS Unicode property escapes expose Bidi_Control but not Bidi_Class.
const rtlCharacters = new RegExp(
  [
    /[\u0590\u05be\u05c0\u05c3\u05c6\u05c8-\u05ff\u0608\u060b\u060d\u061b-\u064a\u066d-\u066f\u0671-\u06d5]/u
      .source,
    /[\u06e5-\u06e6\u06ee-\u06ef\u06fa-\u0710\u0712-\u072f\u074b-\u07a5\u07b1-\u07ea\u07f4-\u07f5\u07fa-\u07fc]/u
      .source,
    /[\u07fe-\u0815\u081a\u0824\u0828\u082e-\u0858\u085c-\u088f\u0892-\u0896\u08a0-\u08c9\u200f\ufb1d\ufb1f-\ufb28]/u
      .source,
    /[\ufb2a-\ufbc2\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfc\ufe70-\ufefe\u{10800}-\u{1091e}]/u
      .source,
    /[\u{10920}-\u{10a00}\u{10a04}\u{10a07}-\u{10a0b}\u{10a10}-\u{10a37}\u{10a3b}-\u{10a3e}\u{10a40}-\u{10ae4}]/u
      .source,
    /[\u{10ae7}-\u{10b38}\u{10b40}-\u{10d23}\u{10d28}-\u{10d2f}\u{10d3a}-\u{10d3f}\u{10d4a}-\u{10d68}]/u
      .source,
    /[\u{10d6f}-\u{10e5f}\u{10e7f}-\u{10eaa}\u{10ead}-\u{10ecf}\u{10ed9}-\u{10ef9}\u{10f00}-\u{10f45}]/u
      .source,
    /[\u{10f51}-\u{10f81}\u{10f86}-\u{10fff}\u{1e800}-\u{1e8cf}\u{1e8d7}-\u{1e943}\u{1e94b}-\u{1eeef}]/u
      .source,
    /[\u{1eef2}-\u{1efff}]/u.source,
  ].join("|"),
  "gu",
);

// After removing R/AL, most L/EN/AN characters are letters, numbers, spacing
// marks, private use or unassigned. These two sets are the exact differences
// from those general categories, including directional symbols and punctuation.
const extraLtrCharacters = new RegExp(
  [
    /[\u0482\u055a-\u055f\u0589\u0600-\u0605\u066b-\u066c\u06dd\u0890-\u0891\u08e2\u0964-\u0965\u0970\u09fa\u09fd]/u
      .source,
    /[\u0a76\u0af0\u0b70\u0c77\u0c7f\u0c84\u0cbf\u0cc6\u0d4f\u0d79\u0df4\u0e4f\u0e5a-\u0e5b\u0f01-\u0f17]/u
      .source,
    /[\u0f1a-\u0f1f\u0f34\u0f36\u0f38\u0f85\u0fbe-\u0fc5\u0fc7-\u0fcc\u0fce-\u0fda\u104a-\u104f\u109e-\u109f\u10fb]/u
      .source,
    /[\u1360-\u1368\u166d-\u166e\u16eb-\u16ed\u1735-\u1736\u17d4-\u17d6\u17d8-\u17da\u1a1e-\u1a1f\u1aa0-\u1aa6]/u
      .source,
    /[\u1aa8-\u1aad\u1b4e-\u1b4f\u1b5a-\u1b6a\u1b74-\u1b7f\u1bfc-\u1bff\u1c3b-\u1c3f\u1c7e-\u1c7f\u1cc0-\u1cc7\u1cd3]/u
      .source,
    /[\u200e\u214f\u2336-\u237a\u2395\u249c-\u24e9\u26ac\u2800-\u28ff\u2d70\u3190-\u3191\u3196-\u319f\u3200-\u321c]/u
      .source,
    /[\u322a-\u3247\u3260-\u327b\u327f\u328a-\u32b0\u32c0-\u32cb\u32d0-\u3376\u337b-\u33dd\u33e0-\u33fe\ua4fe-\ua4ff]/u
      .source,
    /[\ua6f2-\ua6f7\ua789-\ua78a\ua836-\ua837\ua8ce-\ua8cf\ua8f8-\ua8fa\ua8fc\ua92e-\ua92f\ua95f\ua9c1-\ua9cd]/u
      .source,
    /[\ua9de-\ua9df\uaa5c-\uaa5f\uaa77-\uaa79\uaade-\uaadf\uaaf0-\uaaf1\uab5b\uabeb\u{10100}\u{10102}]/u
      .source,
    /[\u{10137}-\u{1013f}\u{1018d}-\u{1018e}\u{101d0}-\u{101fc}\u{1039f}\u{103d0}\u{1056f}\u{11047}-\u{1104d}]/u
      .source,
    /[\u{110bb}-\u{110c1}\u{110cd}\u{11140}-\u{11143}\u{11174}-\u{11175}\u{111c5}-\u{111c8}\u{111cd}\u{111db}]/u
      .source,
    /[\u{111dd}-\u{111df}\u{11238}-\u{1123d}\u{112a9}\u{113d4}-\u{113d5}\u{113d7}-\u{113d8}\u{1144b}-\u{1144f}]/u
      .source,
    /[\u{1145a}-\u{1145b}\u{1145d}\u{114c6}\u{115c1}-\u{115d7}\u{11641}-\u{11643}\u{116b9}\u{1173c}-\u{1173f}]/u
      .source,
    /[\u{1183b}\u{11944}-\u{11946}\u{119e2}\u{11a07}-\u{11a08}\u{11a3f}-\u{11a46}\u{11a9a}-\u{11a9c}]/u
      .source,
    /[\u{11a9e}-\u{11aa2}\u{11b00}-\u{11b09}\u{11be1}\u{11c3f}\u{11c41}-\u{11c45}\u{11c70}-\u{11c71}]/u
      .source,
    /[\u{11ef7}-\u{11ef8}\u{11f43}-\u{11f4f}\u{11fff}\u{12470}-\u{12474}\u{12ff1}-\u{12ff2}\u{13430}-\u{1343f}]/u
      .source,
    /[\u{16a6e}-\u{16a6f}\u{16af5}\u{16b37}-\u{16b3f}\u{16b44}-\u{16b45}\u{16d6d}-\u{16d6f}\u{16e97}-\u{16e9a}]/u
      .source,
    /[\u{1bc9c}\u{1bc9f}\u{1ccd6}-\u{1ccef}\u{1cf50}-\u{1cfc3}\u{1d000}-\u{1d0f5}\u{1d100}-\u{1d126}]/u
      .source,
    /[\u{1d129}-\u{1d164}\u{1d16a}-\u{1d16c}\u{1d183}-\u{1d184}\u{1d18c}-\u{1d1a9}\u{1d1ae}-\u{1d1e8}]/u
      .source,
    /[\u{1d800}-\u{1d9ff}\u{1da37}-\u{1da3a}\u{1da6d}-\u{1da74}\u{1da76}-\u{1da83}\u{1da85}-\u{1da8b}\u{1e14f}]/u
      .source,
    /[\u{1e5ff}\u{1f110}-\u{1f12e}\u{1f130}-\u{1f169}\u{1f170}-\u{1f1ac}\u{1f1e6}-\u{1f202}\u{1f210}-\u{1f23b}]/u
      .source,
    /[\u{1f240}-\u{1f248}\u{1f250}-\u{1f251}]/u.source,
  ].join("|"),
  "u",
);
const neutralExceptions = new RegExp(
  [
    /[\u00bc-\u00be\u02b9-\u02ba\u02c6-\u02cf\u02ec\u0374\u0c78-\u0c7e\u17f0-\u17f9\u2065\u20c2-\u20cf\u2150-\u215f]/u
      .source,
    /[\u2189\u2460-\u2487\u24ea-\u24ff\u2776-\u2793\u2cfd\u2e2f\u3251-\u325f\u32b1-\u32bf\ua67f\ua717-\ua71f\ua788]/u
      .source,
    /[\ufdd0-\ufdef\ufff0-\ufff8\ufffe-\uffff\u{10140}-\u{10178}\u{1018a}-\u{1018b}\u{11052}-\u{11065}]/u
      .source,
    /[\u{1f10b}-\u{1f10c}\u{1fffe}-\u{1ffff}\u{2fffe}-\u{2ffff}\u{3fffe}-\u{3ffff}\u{4fffe}-\u{4ffff}]/u
      .source,
    /[\u{5fffe}-\u{5ffff}\u{6fffe}-\u{6ffff}\u{7fffe}-\u{7ffff}\u{8fffe}-\u{8ffff}\u{9fffe}-\u{9ffff}]/u
      .source,
    /[\u{afffe}-\u{affff}\u{bfffe}-\u{bffff}\u{cfffe}-\u{cffff}\u{dfffe}-\u{e0000}\u{e0002}-\u{e001f}]/u
      .source,
    /[\u{e0080}-\u{e00ff}\u{e01f0}-\u{e0fff}\u{efffe}-\u{effff}\u{ffffe}-\u{fffff}\u{10fffe}-\u{10ffff}]/u
      .source,
  ].join("|"),
  "gu",
);

function mixedDirectionLine(line: string) {
  const rest = line.replace(rtlCharacters, "");
  if (rest.length === line.length) return false;
  return (
    extraLtrCharacters.test(rest) ||
    /[\p{L}\p{N}\p{Mc}\p{Co}\p{Cn}\p{Cs}]/u.test(
      rest.replace(neutralExceptions, ""),
    )
  );
}

export const outlineLineBreak = /\r\n|[\r\n\u2028\u2029]/u;

function textProblem(doc: DesignDocument, nodeId: string) {
  const raw = editableNode(doc, nodeId);
  if (raw?.type !== "text") return protectedText;
  const n = resolveNode(doc, raw);
  if (!n.text.trim()) return protectedText;
  if (raw.textRuns?.length || n.textRuns?.length)
    return "暂不支持将含多字体或分段样式的文本直接转为轮廓，请先统一文字样式";
  if (n.style.textDecoration && n.style.textDecoration !== "none")
    return "暂不支持将带下划线或删除线的文本直接转为轮廓，请先移除文字装饰";
  if (n.style.gradient || n.style.paints?.length || n.image)
    return unsupportedPaint;
  // HarfBuzz guesses a single direction per line. Reject bidi controls and
  // lines combining RTL letters with other scripts or numeric LTR runs.
  if (
    n.style.maxLines ||
    /\p{Bidi_Control}/u.test(n.text) ||
    n.text.split(outlineLineBreak).some(mixedDirectionLine)
  )
    return unsupportedText;
}

export function canOutlineText(doc: DesignDocument, nodeId: string): boolean {
  return !textProblem(doc, nodeId);
}

export function requireOutlineText(doc: DesignDocument, nodeId: string) {
  const problem = textProblem(doc, nodeId);
  if (problem) throw Error(problem);
}

function compound(d: string) {
  const api = kernel();
  return new api.CompoundPath({ pathData: d, insert: false });
}

function traceInk(path: paper.CompoundPath) {
  const api = kernel();
  return path.unite(new api.Path({ insert: false }), { insert: false });
}

function hasArea(path: paper.PathItem) {
  const api = kernel();
  return (
    (path instanceof api.Path || path instanceof api.CompoundPath) &&
    Math.abs(path.area) > 1e-6
  );
}

const MIN_FILLED_INK_AREA = 1e-4; // px²

// Coefficients in ascending powers of t. An elliptical arc is rational
// quadratic, so substituting an edge into another ellipse gives a polynomial.
function sumPoly(a: number[], b: number[], scale = 1) {
  return Array.from(
    { length: Math.max(a.length, b.length) },
    (_, i) => (a[i] ?? 0) + scale * (b[i] ?? 0),
  );
}

function product(a: number[], b: number[]) {
  const result = Array<number>(a.length + b.length - 1).fill(0);
  for (const [i, x] of a.entries())
    for (const [j, y] of b.entries()) result[i + j] += x * y;
  return result;
}

function valueAt(poly: number[], t: number) {
  return poly.reduceRight((v, c) => v * t + c, 0);
}

function derivative(poly: number[]) {
  return poly.slice(1).map((v, i) => v * (i + 1));
}

// Include derivative roots as harmless extra cuts. This includes tangencies
// (even-multiplicity roots) without an absolute coordinate tolerance.
function polynomialCuts(coefficients: number[]): number[] {
  let n = coefficients.length;
  while (n && coefficients[n - 1] === 0) n--;
  if (n <= 1) return [];
  if (n === 2) {
    const t = -coefficients[0] / coefficients[1];
    return t > 0 && t < 1 ? [t] : [];
  }
  const poly = coefficients.slice(0, n);
  const critical = polynomialCuts(derivative(poly));
  const cuts = [0, ...critical, 1];
  const roots = [...critical];
  for (let i = 1; i < cuts.length; i++) {
    let lo = cuts[i - 1],
      hi = cuts[i];
    const sign = Math.sign(valueAt(poly, lo));
    if (sign * Math.sign(valueAt(poly, hi)) !== -1) continue;
    for (let j = 0; j < 54; j++) {
      const mid = (lo + hi) / 2,
        v = valueAt(poly, mid);
      if (v === 0 || mid === lo || mid === hi) {
        lo = hi = mid;
        break;
      }
      if (Math.sign(v) === sign) lo = mid;
      else hi = mid;
    }
    roots.push((lo + hi) / 2);
  }
  return roots.sort((a, b) => a - b);
}

type Ellipse = {
  cx: number;
  cy: number;
  cos: number;
  sin: number;
  rx: number;
  ry: number;
};
type InkEdge = {
  x: number[];
  y: number[];
  w: number[];
  end: Point;
  bounds: StrokeExtent;
  // Interior extrema of a curve projected onto a unit vector (lines need only endpoints).
  projectedRange?: (dx: number, dy: number) => { min: number; max: number };
  bezier?: paper.Path;
  ellipse?: Ellipse;
  // Signed area between this section and its chord, from lo to hi.
  segmentArea: (lo: number, hi: number) => number;
};

type DoubleDouble = [hi: number, lo: number];

// Error-free transforms of two binary64 operands (Dekker / Knuth). Negating
// the second operand of twoSum gives the exact difference, including its tail.
function twoSum(a: number, b: number): DoubleDouble {
  const sum = a + b,
    bv = sum - a;
  return [sum, a - (sum - bv) + (b - bv)];
}

function twoProd(a: number, b: number): DoubleDouble {
  const product = a * b,
    ca = 134217729 * a,
    cb = 134217729 * b;
  const ah = ca - (ca - a),
    al = a - ah;
  const bh = cb - (cb - b),
    bl = b - bh;
  return [product, ah * bh - product + ah * bl + al * bh + al * bl];
}

function ddAdd([a, at]: DoubleDouble, [b, bt]: DoubleDouble): DoubleDouble {
  const [sum, tail] = twoSum(a, b);
  return twoSum(sum, tail + (at + bt));
}

function ddMul([a, at]: DoubleDouble, [b, bt]: DoubleDouble): DoubleDouble {
  const [p, tail] = twoProd(a, b);
  return twoSum(p, tail + (a * bt + at * b));
}

function ddDiv([a, at]: DoubleDouble, b: number): DoubleDouble {
  const q = a / b,
    [p, tail] = twoProd(q, b);
  return twoSum(q, (a - p + (at - tail)) / b);
}

type SvgDecimal = { digits: bigint; power: number };
type ArcChord = { x: SvgDecimal; y: SvgDecimal };

function svgDecimal(value: number): SvgDecimal {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return {
    digits: BigInt(whole + fraction),
    power: Number(exponent) - fraction.length,
  };
}

function addDecimal(a: SvgDecimal, b: SvgDecimal, factor = 1n): SvgDecimal {
  const power = Math.min(a.power, b.power);
  const digits =
    a.digits * 10n ** BigInt(a.power - power) +
    factor * b.digits * 10n ** BigInt(b.power - power);
  return { digits, power };
}

function decimalNumber({ digits, power }: SvgDecimal) {
  return Number(`${digits}e${power}`);
}

// Keep any displacement smaller than the last digit of the rounded chord.
function chordNumber(delta: SvgDecimal): DoubleDouble {
  const hi = decimalNumber(delta);
  return [hi, decimalNumber(addDecimal(delta, svgDecimal(hi), -1n))];
}

function decimalDiameter(delta: SvgDecimal, radius: number) {
  return (
    addDecimal(delta, svgDecimal(radius), delta.digits < 0n ? 2n : -2n)
      .digits === 0n
  );
}

// Resolve SVG coordinates before abs() can round away a relative displacement.
// All controls in a segment are relative to its starting point. Only the final
// coordinate on each axis carries into the next command.
function resolveSvgCoordinates(
  path: ReturnType<typeof svgpath>,
  mode: "all" | "moves",
) {
  const chords = new Map<number, ArcChord>();
  let cx = svgDecimal(0),
    cy = cx,
    sx = cx,
    sy = cy;
  path.iterate((s, index) => {
    const command = s[0].toUpperCase() as Uppercase<(typeof s)[0]>;
    const relative = s[0] !== command;
    const absolute = mode === "all" || command === "M";
    if (absolute) s[0] = command;
    if (command === "Z") {
      cx = sx;
      cy = sy;
      return;
    }
    const startX = cx,
      startY = cy;
    const first = command === "A" ? 6 : 1;
    for (let i = first; i < s.length; i++) {
      const horizontal = command !== "V" && (i - first) % 2 === 0;
      const value = svgDecimal(Number(s[i]));
      const end = relative
        ? addDecimal(horizontal ? startX : startY, value)
        : value;
      if (absolute && relative) s[i] = decimalNumber(end);
      if (horizontal) cx = end;
      else cy = end;
    }
    if (mode === "all" && command === "A")
      chords.set(index, {
        x: addDecimal(cx, startX, -1n),
        y: addDecimal(cy, startY, -1n),
      });
    if (command === "M") {
      sx = cx;
      sy = cy;
    }
  });
  return chords;
}

function arcEdges(
  start: Point,
  end: Point,
  rx: number,
  ry: number,
  rotation: number,
  large: number,
  sweep: number,
  chord: ArcChord,
): InkEdge[] {
  // An exact quarter turn is the same axis-aligned ellipse with swapped radii.
  // Canonicalize before both diameter recognition and endpoint-to-center conversion.
  if (rotation % 90 === 0) {
    const rem = ((rotation % 180) + 180) % 180;
    if (rem === 90) [rx, ry] = [ry, rx];
    rotation = 0;
  }
  const phi = rx === ry ? 0 : (rotation * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = ddMul(chordNumber(chord.x), [-0.5, 0]),
    dy = ddMul(chordNumber(chord.y), [-0.5, 0]);
  let u = ddDiv(ddAdd(ddMul(dx, [cos, 0]), ddMul(dy, [sin, 0])), rx),
    v = ddDiv(ddAdd(ddMul(dy, [cos, 0]), ddMul(dx, [-sin, 0])), ry);
  if (phi === 0 && chord.y.digits === 0n && decimalDiameter(chord.x, rx))
    u = [Math.sign(dx[0]), 0];
  if (phi === 0 && chord.x.digits === 0n && decimalDiameter(chord.y, ry))
    v = [Math.sign(dy[0]), 0];
  const [square, tail] = ddAdd(ddMul(u, u), ddMul(v, v));
  const [rad] = ddAdd([1, 0], [-square, -tail]);
  const length = Math.hypot(u[0], v[0]);
  const diametric = rad <= 0;
  const scale = diametric ? length : 1;
  rx *= scale;
  ry *= scale;
  const height = diametric ? 0 : (large === sweep ? -1 : 1) * Math.sqrt(rad);
  const ex = height * (v[0] / length),
    ey = -height * (u[0] / length);
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const cx = midX + cos * rx * ex - sin * ry * ey;
  const cy = midY + sin * rx * ex + cos * ry * ey;
  const ellipse = { cx, cy, rx, ry, cos, sin };
  const startAngle = Math.atan2(v[0] / scale - ey, u[0] / scale - ex);
  const minor = diametric ? Math.PI : 2 * Math.atan2(length, Math.abs(height));
  const delta = (sweep ? 1 : -1) * (large ? 2 * Math.PI - minor : minor);
  const count = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  const step = delta / count,
    k = Math.tan(step / 2);
  return Array.from({ length: count }, (_, i) => {
    const angle = startAngle + step * i,
      c = Math.cos(angle),
      s = Math.sin(angle);
    // tan(theta / 2) parameterization, with a nonsingular denominator.
    function axis(startCoord: number, endCoord: number, a: number, b: number) {
      const radial = a * c + b * s,
        tangent = b * c - a * s;
      // Displace from the SVG endpoint instead of subtracting a distant center.
      const half = (step * i) / 2;
      const anchor =
        startCoord +
        2 *
          Math.sin(half) *
          (b * Math.cos(startAngle + half) - a * Math.sin(startAngle + half));
      const at = (t: number) =>
        anchor +
        2 *
          Math.sin(t / 2) *
          (tangent * Math.cos(t / 2) - radial * Math.sin(t / 2));
      const finish = i + 1 === count ? endCoord : at(step);
      // Consecutive stationary angles are π apart. At most one is on this arc.
      let turn = Math.atan2(tangent, radial) % Math.PI;
      if (turn * step < 0) turn += Math.sign(step) * Math.PI;
      const extreme = Math.abs(turn) < Math.abs(step) ? at(turn) : anchor;
      return {
        coefficients: [anchor, 2 * k * tangent, k * k * (anchor - 2 * radial)],
        finish,
        min: Math.min(anchor, finish, extreme),
        max: Math.max(anchor, finish, extreme),
      };
    }
    const x = axis(start.x, end.x, rx * cos, -ry * sin),
      y = axis(start.y, end.y, rx * sin, ry * cos);
    return {
      x: x.coefficients,
      y: y.coefficients,
      w: [1, 0, k * k],
      end: { x: x.finish, y: y.finish },
      bounds: { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max },
      projectedRange: (dx, dy) =>
        axis(
          dx * start.x + dy * start.y,
          dx * end.x + dy * end.y,
          rx * (dx * cos + dy * sin),
          ry * (dy * cos - dx * sin),
        ),
      ellipse,
      segmentArea(lo: number, hi: number) {
        const angle = 2 * Math.atan2(k * (hi - lo), 1 + k * k * lo * hi);
        return ((rx * ry) / 2) * (angle - Math.sin(angle));
      },
    };
  });
}

function pointAt(edge: InkEdge, t: number): Point {
  const w = valueAt(edge.w, t);
  return { x: valueAt(edge.x, t) / w, y: valueAt(edge.y, t) / w };
}

function ellipseCuts(ellipse: Ellipse, edge: InkEdge) {
  const { cos, sin, cx, cy, rx, ry } = ellipse;
  const x = sumPoly(edge.x, edge.w, -cx),
    y = sumPoly(edge.y, edge.w, -cy);
  const u = sumPoly(
    x.map((v) => (v * cos) / rx),
    y,
    sin / rx,
  );
  const v = sumPoly(
    y.map((v) => (v * cos) / ry),
    x,
    -sin / ry,
  );
  return polynomialCuts(
    sumPoly(sumPoly(product(u, u), product(v, v)), product(edge.w, edge.w), -1),
  );
}

type InkContour = {
  bounds: StrokeExtent;
  d: string;
  edges: InkEdge[];
  arcErrorBound: number;
};

function inkContours(data: string) {
  const path = svgpath(data);
  const api = kernel(),
    contours: InkContour[] = [];
  let edges: InkEdge[] = [],
    d = "";
  let first: Point | undefined, last: Point;
  let arcErrorBound = 0;
  function polynomialEdge(end: Point, controls: Point[] = []) {
    const start = last;
    last = end;
    if (!controls.length) {
      if (end.x !== start.x || end.y !== start.y)
        edges.push({
          x: [start.x, end.x - start.x],
          y: [start.y, end.y - start.y],
          w: [1],
          end,
          bounds: {
            minX: Math.min(start.x, end.x),
            maxX: Math.max(start.x, end.x),
            minY: Math.min(start.y, end.y),
            maxY: Math.max(start.y, end.y),
          },
          segmentArea: () => 0,
        });
      return;
    }
    const path = new api.Path({ insert: false });
    const point = (p: Point) => new api.Point(p.x, p.y);
    path.moveTo(point(start));
    if (controls.length === 2)
      path.cubicCurveTo(point(controls[0]), point(controls[1]), point(end));
    else path.quadraticCurveTo(point(controls[0]), point(end));
    const curve = path.firstCurve;
    const { left, right, top, bottom } = curve.bounds;
    function axis(k: "x" | "y") {
      const [a, b, c, d] = curve.points.map((p) => p[k]);
      return [
        a,
        3 * (b - a),
        3 * (c - b - (b - a)),
        d - c - 2 * (c - b) + (b - a),
      ];
    }
    const x = axis("x"),
      y = axis("y");
    edges.push({
      x,
      y,
      w: [1],
      end,
      projectedRange(dx, dy) {
        const p = x.map((v, i) => dx * v + dy * y[i]);
        const extrema = polynomialCuts(derivative(p)).map((t) => valueAt(p, t));
        const last = dx * end.x + dy * end.y;
        return {
          min: Math.min(p[0], last, ...extrema),
          max: Math.max(p[0], last, ...extrema),
        };
      },
      bezier: path,
      bounds: { minX: left, maxX: right, minY: top, maxY: bottom },
      segmentArea(lo, hi) {
        const part = curve.getPart(lo, hi);
        return part.area - part.point1.cross(part.point2) / 2;
      },
    });
  }
  function close() {
    if (!first) return;
    polynomialEdge(first);
    if (edges.length) {
      const bounds = { ...edges[0].bounds };
      for (const edge of edges) includeExtent(bounds, edge.bounds);
      contours.push({ bounds, d: d + "Z", edges, arcErrorBound });
    }
    first = undefined;
    edges = [];
    arcErrorBound = 0;
  }
  const chords = /[aAm]/.test(data)
    ? resolveSvgCoordinates(path, "all")
    : undefined;
  if (!chords) path.abs();
  path.unshort();
  path.iterate((s, index, x, y) => {
    last = { x, y };
    if (s[0] === "M") {
      close();
      first = last = { x: s[1], y: s[2] };
      d = s.join(" ");
      return;
    }
    if (s[0] === "Z") {
      close();
      return;
    }
    if (!first) {
      first = last;
      d = `M${x} ${y}`;
    }
    d += s.join(" ");
    switch (s[0]) {
      case "H":
        return polynomialEdge({ x: s[1], y });
      case "V":
        return polynomialEdge({ x, y: s[1] });
      case "L":
        return polynomialEdge({ x: s[1], y: s[2] });
      case "Q":
        return polynomialEdge({ x: s[3], y: s[4] }, [{ x: s[1], y: s[2] }]);
      case "C":
        return polynomialEdge({ x: s[5], y: s[6] }, [
          { x: s[1], y: s[2] },
          { x: s[3], y: s[4] },
        ]);
      case "A": {
        const end = { x: s[6], y: s[7] };
        const chord = chords!.get(index)!;
        if (!s[1] || !s[2]) return polynomialEdge(end);
        if (chord.x.digits !== 0n || chord.y.digits !== 0n) {
          const arcs = arcEdges(
            last,
            end,
            Math.abs(s[1]),
            Math.abs(s[2]),
            s[3],
            s[4],
            s[5],
            chord,
          );
          for (const arc of arcs) {
            edges.push(arc);
            // A tangent cubic for <= 90 degrees stays within 0.001 of
            // its unit circle. This bounds the swept-area discrepancy
            // even when the resulting slivers have opposite windings.
            arcErrorBound += 0.01 * arc.ellipse!.rx * arc.ellipse!.ry;
          }
        }
        last = end;
        break;
      }
    }
  });
  close();
  return contours;
}

function monotoneSpans(edge: InkEdge, levels: Set<number>) {
  const extrema = sumPoly(
    product(derivative(edge.y), edge.w),
    product(edge.y, derivative(edge.w)),
    -1,
  );
  const cuts = [0, ...polynomialCuts(extrema), 1];
  return cuts.slice(1).flatMap((hi, i) => {
    const lo = cuts[i],
      a = pointAt(edge, lo),
      b = pointAt(edge, hi);
    levels.add(a.y);
    levels.add(b.y);
    if (a.y === b.y) return [];
    const dir = b.y > a.y ? 1 : -1;
    function time(y: number) {
      if (y === a.y) return lo;
      if (y === b.y) return hi;
      let left = lo,
        right = hi;
      for (let j = 0; j < 54; j++) {
        const mid = (left + right) / 2,
          v = pointAt(edge, mid).y;
        if (v === y) return mid;
        const below = v < y;
        if (dir > 0 ? below : !below) left = mid;
        else right = mid;
      }
      return (left + right) / 2;
    }
    return [
      {
        edge,
        time,
        dir,
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      },
    ];
  });
}

// Sweep x events, keeping active y intervals in a tree ordered by minY.
// Opening before closing includes contacts at coincident endpoints.
function sweepBounds(
  bounds: StrokeExtent[],
  visit: (a: number, b: number) => void,
) {
  if (bounds.length < 2) return;
  const order = bounds
    .map((_, i) => i)
    .sort((a, b) => bounds[a].minY - bounds[b].minY);
  const size = 2 ** Math.ceil(Math.log2(bounds.length));
  const maxY = new Float64Array(2 * size).fill(-Infinity);
  const events = order
    .flatMap((index, i) => [
      { x: bounds[index].minX, i, open: true },
      { x: bounds[index].maxX, i, open: false },
    ])
    .sort((a, b) => a.x - b.x || Number(b.open) - Number(a.open));
  for (const { i, open } of events) {
    const index = order[i],
      box = bounds[index];
    function query(node: number, lo: number, hi: number) {
      if (maxY[node] < box.minY || bounds[order[lo]].minY > box.maxY) return;
      if (hi - lo === 1) {
        visit(index, order[lo]);
        return;
      }
      const mid = (lo + hi) / 2;
      query(node * 2, lo, mid);
      query(node * 2 + 1, mid, hi);
    }
    if (open) query(1, 0, size);
    let node = size + i;
    maxY[node] = open ? box.maxY : -Infinity;
    while ((node = Math.floor(node / 2)) > 0)
      maxY[node] = Math.max(maxY[node * 2], maxY[node * 2 + 1]);
  }
}

function projectedBounds(
  contour: InkContour,
  nx: number,
  ny: number,
): StrokeExtent {
  function range(dx: number, dy: number) {
    let min = Infinity,
      max = -Infinity;
    for (const edge of contour.edges) {
      if (edge.projectedRange) {
        const r = edge.projectedRange(dx, dy);
        min = Math.min(min, r.min);
        max = Math.max(max, r.max);
      } else {
        // Use the original endpoint: start + (end - start) can lose low bits.
        const a = dx * edge.x[0] + dy * edge.y[0];
        const b = dx * edge.end.x + dy * edge.end.y;
        min = Math.min(min, a, b);
        max = Math.max(max, a, b);
      }
    }
    return { min, max };
  }
  const n = range(nx, ny),
    u = range(-ny, nx);
  // Keep touching contours together even if projecting their extrema rounds differently.
  const b = contour.bounds;
  const pad =
    16 *
    Number.EPSILON *
    Math.max(
      1,
      Math.abs(b.minX),
      Math.abs(b.maxX),
      Math.abs(b.minY),
      Math.abs(b.maxY),
    );
  return {
    minX: n.min - pad,
    maxX: n.max + pad,
    minY: u.min - pad,
    maxY: u.max + pad,
  };
}

function contourOBB(contour: InkContour) {
  let longest = 0,
    nx = 1,
    ny = 0;
  for (const edge of contour.edges) {
    const dx = edge.end.x - edge.x[0],
      dy = edge.end.y - edge.y[0];
    const length = Math.hypot(dx, dy);
    if (length > longest) {
      longest = length;
      // A segment and its reverse use the same frame.
      const signedLength = dy > 0 || (dy === 0 && dx < 0) ? -length : length;
      nx = -dy / signedLength;
      ny = dx / signedLength;
    }
  }
  const bounds = projectedBounds(contour, nx, ny);
  const halfN = (bounds.maxX - bounds.minX) / 2,
    halfU = (bounds.maxY - bounds.minY) / 2;
  const n = bounds.minX + halfN,
    u = bounds.minY + halfU;
  return {
    nx,
    ny,
    bounds,
    halfN,
    halfU,
    aspect: halfU / halfN,
    cx: nx * n - ny * u,
    cy: ny * n + nx * u,
  };
}

// Test both axes of each OBB. The projection radius of the opposite box is
// the sum of its two half-extents weighted by the axes' dot products.
function orientedBoxesOverlap(
  a: ReturnType<typeof contourOBB>,
  b: ReturnType<typeof contourOBB>,
) {
  const dx = b.cx - a.cx,
    dy = b.cy - a.cy;
  const cos = Math.abs(a.nx * b.nx + a.ny * b.ny);
  const sin = Math.abs(a.nx * b.ny - a.ny * b.nx);
  return (
    Math.abs(dx * a.nx + dy * a.ny) <=
      a.halfN + b.halfN * cos + b.halfU * sin &&
    Math.abs(dy * a.nx - dx * a.ny) <=
      a.halfU + b.halfN * sin + b.halfU * cos &&
    Math.abs(dx * b.nx + dy * b.ny) <=
      b.halfN + a.halfN * cos + a.halfU * sin &&
    Math.abs(dy * b.nx - dx * b.ny) <= b.halfU + a.halfN * sin + a.halfU * cos
  );
}

function groupInkCluster(contours: InkContour[]): InkContour[][] {
  if (contours.length < 2) return [contours];
  const parent = contours.map((_, i) => i);
  function root(i: number) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  const boxes = contours.map(contourOBB);
  const dominant = boxes.reduce((best, box) =>
    box.aspect > best.aspect ? box : best,
  );
  const projections = boxes.map((box, i) =>
    box.nx === dominant.nx && box.ny === dominant.ny
      ? box.bounds
      : projectedBounds(contours[i], dominant.nx, dominant.ny),
  );
  sweepBounds(projections, (a, b) => {
    const first = contours[a].bounds,
      second = contours[b].bounds;
    if (
      first.maxX < second.minX ||
      second.maxX < first.minX ||
      first.maxY < second.minY ||
      second.maxY < first.minY
    )
      return;
    const left = root(a),
      right = root(b);
    if (left !== right && orientedBoxesOverlap(boxes[a], boxes[b]))
      parent[left] = right;
  });
  const groups = new Map<number, InkContour[]>();
  contours.forEach((contour, i) => {
    const id = root(i),
      group = groups.get(id);
    if (group) group.push(contour);
    else groups.set(id, [contour]);
  });
  return [...groups.values()];
}

// Partition at gaps on each world axis before choosing a local sweep direction.
// This avoids enumerating quadratically many overlapping AABBs for parallel strips.
function inkComponents(contours: InkContour[]): InkContour[][] {
  if (contours.length < 2) return contours.length ? [contours] : [];
  function runs(
    items: InkContour[],
    min: "minX" | "minY",
    max: "maxX" | "maxY",
  ) {
    const groups: InkContour[][] = [];
    let end = -Infinity;
    for (const item of items.sort((a, b) => a.bounds[min] - b.bounds[min])) {
      if (item.bounds[min] > end) {
        groups.push([]);
        end = -Infinity;
      }
      groups[groups.length - 1].push(item);
      end = Math.max(end, item.bounds[max]);
    }
    return groups;
  }
  return runs(contours, "minX", "maxX")
    .flatMap((group) => runs(group, "minY", "maxY"))
    .flatMap(groupInkCluster);
}

function nativeInkArea(contours: InkContour[]) {
  const edges = contours.flatMap((c) => c.edges);
  const levels = new Set<number>();
  const api = kernel(),
    beziers = new api.CompoundPath({ insert: false });
  for (const edge of edges) {
    if (!edge.ellipse) {
      beziers.addChild(
        edge.bezier ??
          new api.Path({
            segments: [pointAt(edge, 0), pointAt(edge, 1)],
            insert: false,
          }),
      );
    }
  }
  for (const hit of beziers.getIntersections()) levels.add(hit.point.y);
  function addCuts(arc: InkEdge, edge: InkEdge) {
    if (arc.ellipse && arc.ellipse !== edge.ellipse)
      for (const t of ellipseCuts(arc.ellipse, edge))
        levels.add(pointAt(edge, t).y);
  }
  sweepBounds(
    edges.map((e) => e.bounds),
    (i, j) => {
      addCuts(edges[i], edges[j]);
      addCuts(edges[j], edges[i]);
    },
  );
  const spans = edges
    .flatMap((edge) => monotoneSpans(edge, levels))
    .sort((a, b) => a.minY - b.minY);
  // Between consecutive extrema and intersections the winding order is fixed.
  // Integrate each actual boundary using Green's theorem, including arc sectors.
  const cuts = [...levels].sort((a, b) => a - b),
    active = new Set<(typeof spans)[number]>();
  let area = 0,
    next = 0;
  for (let i = 1; i < cuts.length; i++) {
    const bottom = cuts[i - 1],
      top = cuts[i],
      mid = (bottom + top) / 2;
    while (next < spans.length && spans[next].minY <= bottom)
      active.add(spans[next++]);
    for (const s of active) if (s.maxY <= bottom) active.delete(s);
    const ordered = [...active]
      .map((s) => ({ s, x: pointAt(s.edge, s.time(mid)).x }))
      .sort((a, b) => a.x - b.x);
    let winding = 0;
    const origin = ordered[0]?.x ?? 0;
    for (const { s } of ordered) {
      const before = winding;
      winding += s.dir;
      if (before && winding) continue;
      const lo = s.time(bottom),
        hi = s.time(top);
      const chord =
        ((pointAt(s.edge, lo).x - origin + (pointAt(s.edge, hi).x - origin)) *
          (top - bottom)) /
        2;
      area += (before ? 1 : -1) * (chord + s.edge.segmentArea(lo, hi));
    }
  }
  return area;
}

function bezierInkArea(d: string) {
  try {
    const path = compound(d);
    path.fillRule = "nonzero";
    const unified = traceInk(path);
    const api = kernel();
    if (unified instanceof api.Path || unified instanceof api.CompoundPath)
      return Math.abs(unified.area);
  } catch {
    // Degenerate input can fail Paper's boolean trace.
  }
  return NaN;
}

function hasFilledInk(d: string) {
  try {
    let totalArea = 0;
    for (const group of inkComponents(inkContours(d))) {
      const area = bezierInkArea(group.map((c) => c.d).join(""));
      const error = group.reduce((sum, c) => sum + c.arcErrorBound, 0);
      if (
        Number.isFinite(area) &&
        totalArea + (area - error) >= MIN_FILLED_INK_AREA
      )
        return true;
      // Several small, disjoint regions can add up to visible ink. Accumulate
      // exact areas whenever the cubic estimate cannot prove acceptance.
      // Roundoff on a retrace cannot subtract ink from another component.
      totalArea +=
        Number.isFinite(area) && error === 0
          ? area
          : Math.max(0, nativeInkArea(group));
      if (totalArea >= MIN_FILLED_INK_AREA) return true;
    }
    return false;
  } catch {
    return false;
  }
}

class EmptyTextOutline extends Error {
  constructor() {
    super("文字轮廓没有可见的填充区域");
  }
}

export function normalizedGlyphPath(d: string) {
  const glyph = compound(d);
  // Crossing and coincident contours need their actual nonzero boundaries
  // before nesting is meaningful (e.g. two lobes of a figure eight).
  const ink =
    !hasArea(glyph) || glyph.getIntersections().length
      ? traceInk(glyph)
      : glyph;
  if (!hasArea(ink)) return "";
  const contours = ink === glyph ? ([...glyph.children] as paper.Path[]) : [];
  const starts = new Set(contours.map((c) => c.firstSegment));
  // Font Y points up. Negative outers here become positive after placement
  // in layer pixels. reorient uses containment and reverses Bézier handles.
  ink.reorient(true, false);
  for (const c of contours) {
    if (c.closed && starts.has(c.lastSegment))
      c.insert(0, c.removeSegment(c.segments.length - 1));
  }
  return ink.pathData;
}

function primitiveStroke(n: DesignNode) {
  const s = n.style,
    { width, height } = s,
    ellipse = n.type === "ellipse";
  const outside =
    s.strokeAlign === "outside" ? 1 : s.strokeAlign === "center" ? 0.5 : 0;
  function ring(w: number) {
    const center = w * (0.5 - outside);
    const options = {
      viewport: s,
      strokeDash: s.strokeDash,
      strokeStyle: s.strokeStyle,
      lineCap: "butt",
      lineJoin: "miter",
    } as const;
    const trace = (offset: number, thickness: number) =>
      compound(
        outlineStrokePath(
          roundedContour(width, height, s, ellipse, offset),
          thickness,
          options,
        ),
      );
    if (dashPattern(options, w).length) return trace(center, w);
    if (s.strokeStyle === "double")
      return trace(center - w / 3, w / 3).unite(trace(center + w / 3, w / 3), {
        insert: false,
      });
    const inset = w * (1 - outside);
    const outer = compound(
      roundedContour(width, height, s, ellipse, -w * outside),
    );
    if (width <= 2 * inset || height <= 2 * inset) return outer;
    return outer.subtract(
      compound(roundedContour(width, height, s, ellipse, inset)),
      { insert: false },
    );
  }
  const widths = widthsFor(s);
  if (widths.every((w) => w === widths[0])) return ring(widths[0]).pathData;
  // Match the edge ownership in strokeArtwork for independently sized sides.
  if (
    !ellipse &&
    !s.strokeDash?.trim() &&
    (!s.strokeStyle || s.strokeStyle === "solid") &&
    ![s.corners?.tl, s.corners?.tr, s.corners?.br, s.corners?.bl].some(
      (r) => (r ?? s.radius) > 0,
    )
  ) {
    const [t, r, b, l] = widths.map((w) => w * outside),
      [it, ir, ib, il] = widths.map((w) => w * (1 - outside));
    const outer = compound(`M${-l} ${-t}H${width + r}V${height + b}H${-l}Z`);
    return il + ir >= width || it + ib >= height
      ? outer.pathData
      : outer.subtract(
          compound(`M${il} ${it}H${width - ir}V${height - ib}H${il}Z`),
          { insert: false },
        ).pathData;
  }
  const extent = Math.max(...widths),
    depth = Math.min(width, height) / 2;
  const corners = [
    [-extent, -extent],
    [width + extent, -extent],
    [width + extent, height + extent],
    [-extent, height + extent],
  ];
  const joins = [
    [depth, depth],
    [width - depth, depth],
    [width - depth, height - depth],
    [depth, height - depth],
  ];
  let area: paper.PathItem | undefined;
  for (const [i, w] of widths.entries()) {
    if (!w) continue;
    const j = (i + 1) % 4;
    const clip = compound(
      `M${corners[i]}L${corners[j]}L${joins[j]}L${joins[i]}Z`,
    );
    const edge = ring(w).intersect(clip, { insert: false });
    area = area ? area.unite(edge, { insert: false }) : edge;
  }
  return area?.pathData ?? "";
}

function filled(d: string, fillColor?: string, fillOpacity = 1): Paint {
  return {
    d,
    fill: true,
    strokeWidth: 0,
    fillColor,
    fillOpacity,
    fillRule: "nonzero",
  };
}

function inkBounds(paths: Paint[]) {
  const box = vectorBounds(
    paths.map((p) => ({ ...p, contours: readContours(p.d) })),
    0,
  );
  if (!(box.width > 0 && box.height > 0)) throw Error("没有可转换的可见轮廓");
  return box;
}

function validateDrawing(drawing: Vector) {
  if (!nodeSchema.shape.vector.safeParse(drawing).success)
    throw Error("轮廓超出矢量图层的尺寸或路径容量，请先分段处理");
}

type Conversion = Extract<Operation, { type: "convertToVector" }>;

function translatePaints(paths: Paint[], dx: number, dy: number) {
  if (!dx && !dy) return paths;
  return paths.map((p) => {
    const translated = svgpath(p.d);
    if (/a/i.test(p.d)) {
      // A translation only moves absolute coordinates. The general SVG matrix
      // transform re-fits ellipse radii and angles, perturbing exact diameters.
      translated.iterate((s, index) => {
        if (index && s[0] === s[0].toLowerCase()) return;
        if (s[0] === "A") {
          s[6] += dx;
          s[7] += dy;
        } else if (s[0] === "H") s[1] += dx;
        else if (s[0] === "V") s[1] += dy;
        else {
          for (let i = 1; i < s.length; i += 2) {
            s[i] = Number(s[i]) + dx;
            s[i + 1] = Number(s[i + 1]) + dy;
          }
        }
      });
    } else translated.translate(dx, dy).round(5);
    return { ...p, d: translated.toString() };
  });
}

// All artwork arrives in laid-out local pixels, including vector letterboxing
// and text bearings. Only free layers can trade their layout box for a tight box.
function convertArtwork(
  doc: DesignDocument,
  n: DesignNode,
  paths: Paint[],
  ink: Rect,
  patch: NonNullable<Conversion["patch"]> = {},
  style: Partial<NodeStyle> = {},
  fillFromStyle?: true,
): OutlineResult {
  const bounds = layoutBounds(doc),
    rect = bounds.get(n.id)!;
  const rawParent = findLayer(doc, n.parentId);
  const parent = rawParent && resolveNode(doc, rawParent);
  const flow =
    parent?.type === "frame" &&
    parent.style.layout !== "free" &&
    !n.style.absolutePosition;
  const box = flow
    ? { x: 0, y: 0, width: rect.width, height: rect.height }
    : ink;
  const drawing: Vector = {
    width: box.width,
    height: box.height,
    paths: translatePaints(paths, -box.x, -box.y),
    stretch: flow ? undefined : n.vector ? n.vector.stretch : true,
    fillFromStyle,
    ...(n.vector?.overflowVisible ||
    (flow &&
      (ink.x < 0 ||
        ink.y < 0 ||
        ink.x + ink.width > rect.width ||
        ink.y + ink.height > rect.height))
      ? { overflowVisible: true }
      : {}),
  };
  if (n.type === "text") {
    const source = paths[0].d,
      final = drawing.paths[0].d;
    if (!hasFilledInk(source) || (final !== source && !hasFilledInk(final)))
      throw new EmptyTextOutline();
  }
  validateDrawing(drawing);
  const bindings = { ...(patch.variableBindings ?? n.variableBindings) };
  // Flow owns the measured size. Preserve the preferred Fill basis across reflow.
  const stored = findLayer(doc, n.id)!.style;
  style.width = flow && n.style.widthMode === "fill" ? stored.width : box.width;
  style.height =
    flow && n.style.heightMode === "fill" ? stored.height : box.height;
  if (!flow) {
    // Ancestor transforms apply equally before and after conversion. Express
    // the new ink center in the same (unrotated) parent coordinate system.
    const center = transform(localTransform(n, rect), {
      x: rect.x + ink.x + ink.width / 2,
      y: rect.y + ink.y + ink.height / 2,
    });
    const parentRect = parent && bounds.get(parent.id);
    style.widthMode = style.heightMode = "fixed";
    for (const axis of ["width", "height"] as const) {
      const pos = axis === "width" ? "x" : "y";
      const key = axis === "width" ? "constraintX" : "constraintY";
      const mode = parent?.style.layout === "free" ? n.style[key] : undefined;
      const oldParentSize = parent?.style[axis] ?? 0;
      const parentSize = parentRect?.[axis] ?? oldParentSize;
      const scale =
        mode === "scale" && oldParentSize > 0 ? parentSize / oldParentSize : 1;
      const start = center[pos] - ink[axis] / 2;
      // Write design coordinates. sizeScene will apply the parent's active
      // center/end/stretch/scale constraints again when this document reopens.
      style[pos] = n.style[pos] + (start - rect[pos]) / (scale || 1);
      const designSize =
        mode === "stretch"
          ? ink[axis] - (parentSize - oldParentSize)
          : ink[axis] / (scale || 1);
      if (designSize >= 0 && scale > 0) style[axis] = designSize;
      else {
        style[key] = "start";
        style[pos] = start - (parentRect?.[pos] ?? 0);
      }
      if (ink[axis] !== rect[axis]) {
        delete bindings[axis];
        const [min, max] =
          axis === "width"
            ? (["minWidth", "maxWidth"] as const)
            : (["minHeight", "maxHeight"] as const);
        if (ink[axis] < (n.style[min] ?? 0)) {
          style[min] = undefined;
          delete bindings[min];
        }
        if (ink[axis] > (n.style[max] ?? Infinity)) {
          style[max] = undefined;
          delete bindings[max];
        }
      }
    }
  }
  if (n.variableBindings || patch.variableBindings)
    patch.variableBindings = bindings;
  return {
    nodeId: n.id,
    operations: [
      {
        type: "convertToVector",
        id: n.id,
        vector: drawing,
        patch,
        style,
      },
    ],
  };
}

function primitiveArtwork(doc: DesignDocument, n: DesignNode, rect: Rect) {
  const s = n.style,
    paths: Paint[] = [];
  const bindings = { ...n.variableBindings };
  const inheritedFill = liveFill(n);
  const inheritedStroke = liveStroke(n);
  const style: Partial<NodeStyle> = {
    strokeWidth: 0,
    ...(s.strokeSides ? { strokeSides: {} } : {}),
    radius: 0,
    ...(s.corners ? { corners: { tl: 0, tr: 0, br: 0, bl: 0 } } : {}),
  };
  const fill = (n.fillToken && doc.tokens[n.fillToken]?.value) || s.fill;
  if (inheritedFill || visible(fill, s.fillOpacity)) {
    paths.push(
      filled(
        roundedContour(rect.width, rect.height, s, n.type === "ellipse"),
        inheritedFill ? undefined : fill,
        inheritedFill ? 1 : s.fillOpacity,
      ),
    );
    if (inheritedFill) style.fill = fill;
  }
  const stroke = primitiveStroke({
    ...n,
    style: { ...s, width: rect.width, height: rect.height },
  });
  if (stroke)
    paths.push(
      filled(
        stroke,
        inheritedStroke ? undefined : (s.stroke ?? s.color),
        inheritedStroke ? 1 : s.strokeOpacity,
      ),
    );
  if (inheritedStroke) {
    style.color = s.stroke ?? s.color;
    style.colorOpacity = s.strokeOpacity ?? 1;
    const color = bindings.stroke ?? (!s.stroke ? bindings.color : undefined);
    delete bindings.color;
    delete bindings.colorOpacity;
    if (color) bindings.color = color;
    if (bindings.strokeOpacity) bindings.colorOpacity = bindings.strokeOpacity;
    delete bindings.stroke;
    delete bindings.strokeOpacity;
  }
  // These geometry variables have been baked into the closed contours.
  for (const k of Object.keys(bindings) as (keyof typeof bindings)[])
    if (
      k === "strokeWidth" ||
      k === "radius" ||
      k.startsWith("strokeSides.") ||
      k.startsWith("corners.")
    )
      delete bindings[k];
  return convertArtwork(
    doc,
    n,
    paths,
    inkBounds(paths),
    {
      name: n.name + "（轮廓）",
      ...(n.variableBindings ? { variableBindings: bindings } : {}),
    },
    style,
    inheritedFill || undefined,
  );
}

function fillArea(path: Paint) {
  const area = compound(path.d);
  for (const child of area.children as paper.Path[]) child.closed = true;
  area.fillRule = path.fillRule ?? "nonzero";
  return area;
}

function changedArea(paint: Paint, area: paper.PathItem): Paint[] {
  return !area.pathData
    ? []
    : [
        {
          ...paint,
          d: area.pathData,
          junctions: undefined,
          fillRule: "nonzero",
        },
      ];
}

function expandedPath(n: DesignNode, path: Paint) {
  // SVG hex colors can include alpha. The vector schema stores it separately.
  if (path.fillColor && /^#[0-9a-f]{8}$/i.test(path.fillColor)) {
    path = {
      ...path,
      fillColor: path.fillColor.slice(0, 7),
      fillOpacity:
        ((path.fillOpacity ?? 1) * parseInt(path.fillColor.slice(7), 16)) / 255,
    };
  }
  const paths: Paint[] = [];
  const groupAlpha = path.opacity ?? 1;
  const stroke = hasVisibleVectorStroke(n, path)
    ? outlineStrokePath(path.d, path.strokeWidth, {
        ...path,
        viewport: n.vector,
        strokeDash: n.style.strokeDash,
        strokeStyle: n.style.strokeStyle,
      })
    : "";
  if (
    path.fill &&
    visible(path.fillColor, path.fillOpacity) &&
    groupAlpha > 0
  ) {
    const fill = { ...path, strokeWidth: 0 };
    delete fill.strokeColor;
    delete fill.strokeOpacity;
    if (
      stroke &&
      groupAlpha < 1 &&
      !(n.vector?.fillFromStyle && !path.fillColor)
    ) {
      const region = fillArea(fill),
        outline = compound(stroke);
      const strokeAlpha =
        (path.strokeOpacity ?? 1) *
        (path.strokeColor ? 1 : (n.style.colorOpacity ?? 1));
      paths.push(
        ...changedArea(fill, region.subtract(outline, { insert: false })),
      );
      // SVG applies path opacity after compositing fill and stroke. The stroke
      // is drawn last with alpha g*s. In its overlap the visible contribution
      // of the fill must equal g*f*(1-s), including partially transparent ink.
      if (strokeAlpha < 1)
        paths.push(
          ...changedArea(
            {
              ...fill,
              fillOpacity:
                ((fill.fillOpacity ?? 1) * (1 - strokeAlpha)) /
                (1 - groupAlpha * strokeAlpha),
            },
            region.intersect(outline, { insert: false }),
          ),
        );
    } else {
      const contours = readContours(fill.d);
      if (contours.some((c) => !c.closed)) {
        contours.forEach((c) => {
          c.closed = true;
        });
        fill.d = pathData(contours);
      }
      paths.push(fill);
    }
  }
  const mask = n.vector?.fillFromStyle && !path.strokeColor;
  return {
    fills: paths,
    outline: stroke
      ? {
          ...filled(
            stroke,
            path.strokeColor ?? (mask ? n.style.color : undefined),
            (path.strokeOpacity ?? 1) *
              (mask ? (n.style.colorOpacity ?? 1) : 1),
          ),
          opacity: path.opacity,
        }
      : undefined,
  };
}

export function outlineStrokeOperations(
  doc: DesignDocument,
  nodeId: string,
): OutlineResult {
  const raw = editableNode(doc, nodeId);
  const n = raw && resolveNode(doc, raw);
  const rect = n && layoutBounds(doc).get(nodeId);
  const problem = strokeProblem(doc, n, rect);
  if (problem || !n || !rect) throw Error(problem);
  if (n.type !== "vector") return primitiveArtwork(doc, n, rect);
  const source = n.vector!;
  const { w, h, sx, sy, x, y } = viewport(source, rect);
  const clipAll = !source.overflowVisible || n.style.clipContent;
  const clip =
    clipAll || source.fillFromStyle ? compound(`M0 0H${w}V${h}H0Z`) : undefined;
  function project(p: Paint): Paint[] {
    const paint = {
      ...p,
      d: svgpath(p.d).scale(sx, sy).translate(x, y).round(5).toString(),
    };
    if (!clip || (!clipAll && p.fillColor)) return [paint];
    const region = fillArea(paint);
    if (clip.bounds.contains(region.bounds)) return [paint];
    return changedArea(paint, region.intersect(clip, { insert: false }));
  }
  const paths: Paint[] = [];
  let hasStroke = false;
  for (const p of source.paths) {
    const { fills, outline } = expandedPath(n, p);
    paths.push(...fills.flatMap(project));
    if (outline) {
      const ink = project(outline);
      if (ink.length) hasStroke = true;
      paths.push(...ink);
    }
  }
  // A conservative Inspector check may admit a path whose actual dashes all miss
  // the viewport. Visible fills alone must never authorize a stroke conversion.
  if (!hasStroke) throw Error(noVisibleStroke);
  return convertArtwork(
    doc,
    n,
    paths,
    inkBounds(paths),
    {},
    {},
    source.fillFromStyle,
  );
}

function glyphPath(
  d: string,
  resolved: DesignNode,
  rule: Paint["fillRule"],
): EditablePath {
  const contours = readContours(d);
  return {
    contours,
    fill: true,
    fillRule: rule,
    ...(resolved.variableBindings?.color ||
    resolved.variableBindings?.colorOpacity ||
    resolved.styleBindings?.paint ||
    resolved.styleBindings?.text
      ? {}
      : {
          fillColor: resolved.style.color,
          fillOpacity: resolved.style.colorOpacity ?? 1,
        }),
    strokeWidth: 0,
  };
}

function measureGlyph(
  resolved: DesignNode,
  pathDataStr: string,
  fillRule: "nonzero" | "evenodd",
) {
  if (!hasFilledInk(pathDataStr)) throw new EmptyTextOutline();
  const path = glyphPath(pathDataStr, resolved, fillRule);
  const alreadyClosed = path.contours.every((c) => c.closed);
  for (const c of path.contours) c.closed = true;
  const bounds = vectorBounds([path], 0);
  const { contours: _contours, ...paint } = path;
  let d = pathDataStr;
  if (!alreadyClosed) {
    const output = svgpath(pathDataStr);
    // An inserted Z changes the origin of the next relative move.
    if (pathDataStr.includes("m")) resolveSvgCoordinates(output, "moves");
    d = output
      .toString()
      .split(/(?=M)/)
      .map((contour) => (/z$/i.test(contour) ? contour : contour + "Z"))
      .join("");
  }
  return { bounds, paint: { ...paint, d } };
}

export function buildTextOutlineVector(
  rawNode: DesignNode,
  resolved: DesignNode,
  pathDataStr: string,
  boxWidth: number,
  boxHeight: number,
  fillRule: "nonzero" | "evenodd" = "nonzero",
): Vector {
  if (
    rawNode.type !== "text" ||
    ![boxWidth, boxHeight].every((v) => Number.isFinite(v) && v >= 0)
  )
    throw Error("文字轮廓尺寸无效");
  const { bounds, paint } = measureGlyph(resolved, pathDataStr, fillRule);
  const drawing: Vector = {
    width: bounds.width,
    height: bounds.height,
    stretch: true,
    paths: translatePaints([paint], -bounds.x, -bounds.y),
  };
  validateDrawing(drawing);
  return drawing;
}

/** glyphBounds is the ink rectangle in the original node's local coordinate system. */
export function createOutlinedVectorFromTextOperations(
  doc: DesignDocument,
  nodeId: string,
  glyphPathD: string,
  glyphBounds: Rect,
): OutlineResult {
  requireOutlineText(doc, nodeId);
  const raw = findLayer(doc, nodeId)!,
    resolved = resolveNode(doc, raw);
  const drawing = buildTextOutlineVector(
    raw,
    resolved,
    glyphPathD,
    glyphBounds.width,
    glyphBounds.height,
  );
  return convertTextArtwork(
    doc,
    raw,
    resolved,
    translatePaints(drawing.paths, glyphBounds.x, glyphBounds.y),
    glyphBounds,
  );
}

function convertTextArtwork(
  doc: DesignDocument,
  raw: DesignNode,
  resolved: DesignNode,
  paths: Paint[],
  bounds: Rect,
): OutlineResult {
  const bindings = { ...raw.variableBindings };
  delete bindings.text;
  return convertArtwork(doc, resolved, paths, bounds, {
    name: raw.name + "（轮廓）",
    ...(raw.variableBindings ? { variableBindings: bindings } : {}),
  });
}

export function outlineTextFromShapeOperations(
  doc: DesignDocument,
  nodeId: string,
): OutlineResult | null {
  if (!canOutlineText(doc, nodeId)) return null;
  const raw = findLayer(doc, nodeId)!,
    n = resolveNode(doc, raw),
    shape = currentTextShape(n);
  if (!shape || currentTextLayout(n)) return null;
  const rect = layoutBounds(doc).get(nodeId)!;
  if (
    Math.abs(shape.width - rect.width) > 1 ||
    Math.abs(shape.height - rect.height) > 1
  )
    return null;
  // Cached artwork already uses local layout pixels, including its bearings.
  // Measure it once and place it directly into the layer's final coordinate space.
  try {
    const { bounds, paint } = measureGlyph(n, shape.d, "nonzero");
    const result = convertTextArtwork(doc, raw, n, [paint], bounds);
    // Flow layers retain their layout box; the ink itself must also fit the schema.
    validateDrawing({
      width: bounds.width,
      height: bounds.height,
      paths: [paint],
    });
    return result;
  } catch (error) {
    // Translation and serialization can erase the last ink of a cached path.
    if (error instanceof EmptyTextOutline) return null;
    throw error;
  }
}
