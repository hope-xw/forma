import {
  createContext,
  Fragment,
  useId,
  useRef,
  useLayoutEffect,
  useContext,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from "react";
export interface RuntimeControl {
  kind:
    | "button"
    | "switch"
    | "checkbox"
    | "textfield"
    | "slider"
    | "stepper"
    | "segmented"
    | "progress";
  label: string;
  value: string | number | boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  palette?: { accent: string; track: string; surface: string; border?: string };
}
export interface GlassSample {
  blurSigma?: number;
  floorOnly?: boolean;
  capturedEnvironment?: boolean;
  paintedAncestor?: string;
  environment: string;
  ancestor: string;
  layer: CSSProperties;
  source: CSSProperties;
  face: CSSProperties;
}
export interface RuntimeNode {
  glass?: GlassSample;
  slotContent?: ReactNode;
  siblingMask?: { style: CSSProperties; assetId?: string; source?: string };
  id: string;
  name: string;
  key?: string;
  component?: string;
  visibleDisplay?: CSSProperties["display"];
  text: string;
  parts?: { text: string; style: CSSProperties }[];
  blendedPaints?: {
    color: string;
    mode?: CSSProperties["mixBlendMode"] | "plus-darker";
  }[];
  boxPaint?: CSSProperties[];
  capsule?: {
    width: number;
    height: number;
    d: string;
    background: CSSProperties["background"];
  };
  boxBurn?: {
    shape: CSSProperties;
    layers: CSSProperties[];
    native: CSSProperties;
  };
  strokePaints?: CSSProperties[];
  boxShadows?: CSSProperties[];
  inkShadows?: {
    x: number;
    y: number;
    blur: number;
    spread: number;
    color: string;
    opacity: number;
    inset: boolean;
    blendMode?: string;
  }[];
  inkPaints?: {
    background: string;
    blend?: CSSProperties["mixBlendMode"];
    backdropFilter?: string;
    opacity?: number;
  }[];
  sourceTextLayout?: {
    text: string;
    width: number;
    height: number;
    lines: { text: string; x: number[]; y: number }[];
  };
  sourceTextShape?: {
    text: string;
    d: string;
    width: number;
    height: number;
    coverageOffsets?: { start: number; shiftY: number }[];
  };
  type: string;
  style: CSSProperties & { [property: `--${string}`]: string | number };
  control?: RuntimeControl;
  gridBreakpoint?: {
    rules: {
      maxWidth: number;
      columns?: number;
      gap?: number;
      rowGap?: number;
      padding?: number;
      radius?: number;
      opacity?: number;
      fill?: string;
    }[];
    hasExplicitRowGap: boolean;
    variable: string;
  };
  geometry?: { width: number; height: number };
  bindings?: {
    text?: string;
    visible?: string;
    display?: CSSProperties["display"];
  };
  image?: {
    assetId: string;
    fit: "cover" | "contain" | "fill" | "tile";
    tileSize?: readonly [number, number];
    opacity?: number;
    filter?: string;
    rotation?: number;
    transform?: string;
    zoom: number;
    x: number;
    y: number;
    source?: string;
  };
  vector?: {
    fillFromStyle?: true;
    stretch?: true;
    overflowVisible?: true;
    radial?:
      | { kind: "star"; points: number; innerRatio: number }
      | { kind: "polygon"; points: number };
    width: number;
    height: number;
    paths: {
      junctions?: { contour: number; anchor: number; id: string }[];
      d: string;
      fill: boolean;
      strokeWidth: number;
      fillColor?: string;
      strokeColor?: string;
      fillRule?: "nonzero" | "evenodd";
      lineCap?: "butt" | "round" | "square";
      lineJoin?: "miter" | "bevel" | "round";
      opacity?: number;
      fillOpacity?: number;
      strokeOpacity?: number;
    }[];
  };
  children: RuntimeNode[];
}
export type DesignAction = (
  id: string,
  value: string | number | boolean,
) => void;
const hitArea: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  padding: 0,
  margin: 0,
  border: 0,
  borderRadius: "inherit",
  background: "transparent",
  color: "transparent",
  cursor: "pointer",
  font: "inherit",
};
type ControlValue = string | number | boolean;
export const ImageResources = createContext<Record<string, { data: string }>>(
  {},
);
// stackPaints emits the visible overlays first and the base fill last. Split
// only between layers, since gradients and token expressions also use commas.
export function separateImageOverlay(style: CSSProperties) {
  const background = style.background;
  if (typeof background !== "string") return;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < background.length; i++) {
    if (background[i] === "(") depth++;
    else if (background[i] === ")") depth--;
    else if (background[i] === "," && depth === 0) {
      parts.push(background.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(background.slice(start).trim());
  if (parts.length < 2) return;
  // A 4-quadrant diamond gradient occupies 4 contiguous layers at the tail.
  const isDiamondQuad = (chunk: string) =>
    chunk.endsWith("/ 50% 50% no-repeat");
  const baseCount =
    parts.length >= 4 && parts.slice(-4).every(isDiamondQuad) ? 4 : 1;
  if (parts.length <= baseCount) return;
  style.background = parts.slice(-baseCount).join(", ");
  style.isolation = "isolate";
  return parts.slice(0, -baseCount).join(", ");
}
// The browser snaps an absolutely positioned SVG viewport to the device-pixel grid.
// Glyph positions are measured in design space, so restore that viewport's fractional origin.
function svgTextPhase(box: HTMLElement) {
  const rect = box.getBoundingClientRect(),
    dpr = window.devicePixelRatio || 1;
  const sx = rect.width / (box.offsetWidth || rect.width),
    sy = rect.height / (box.offsetHeight || rect.height);
  const phase = (at: number, scale: number) =>
    scale ? (at - Math.round(at * dpr) / dpr) / scale : 0;
  return { x: phase(rect.left, sx), y: phase(rect.top, sy) };
}
function NativeTextLines({
  layout,
  phase,
}: {
  layout: NonNullable<RuntimeNode["sourceTextLayout"]>;
  phase: { x: number; y: number };
}) {
  return (
    <>
      {layout.lines.map((line, i) => (
        <text
          key={i}
          fill="currentColor"
          style={{ whiteSpace: "pre", letterSpacing: 0 }}
        >
          {[...line.text].map((c, j) => (
            <tspan key={j} x={line.x[j] + phase.x} y={line.y + phase.y}>
              {c}
            </tspan>
          ))}
        </text>
      ))}
    </>
  );
}
// Native Figma exports use sixteen levels of glyph coverage. Sample the editable
// source outline in small strips at native 1×. Zoomed and HiDPI views keep SVG.
const outlineCoverageCache = new Map<string, string>();
let outlineCoverageBytes = 0;
function outlineCoverage(
  d: string,
  width: number,
  height: number,
  phaseX: number,
  phaseY: number,
  offsets?: { start: number; shiftY: number }[],
  fillRule: CanvasFillRule = "nonzero",
) {
  const w = Math.ceil(width),
    h = Math.ceil(height);
  if (w > 512 || w * h > 96_000) return undefined;
  const key =
    [w, h, phaseX, phaseY, fillRule, JSON.stringify(offsets)].join(",") +
    ":" +
    d;
  const cached = outlineCoverageCache.get(key);
  if (cached) return cached;
  const image = document.createElement("canvas");
  image.width = w;
  image.height = h;
  const output = image.getContext("2d");
  if (!output) return undefined;
  const scale = 16,
    samples = scale * scale;
  const strip = document.createElement("canvas");
  strip.width = w * scale;
  const stripRows = Math.min(
    h,
    Math.max(1, Math.floor(524288 / (w * samples))),
  );
  strip.height = stripRows * scale;
  const input = strip.getContext("2d", { willReadFrequently: true });
  if (!input) return undefined;
  const path = new Path2D(offsets?.length ? undefined : d);
  if (offsets?.length) {
    let start = 0,
      shiftY = 0;
    for (const stop of [...offsets, { start: d.length, shiftY: 0 }]) {
      if (stop.start > start)
        path.addPath(
          new Path2D(d.slice(start, stop.start)),
          new DOMMatrix().translate(0, shiftY),
        );
      start = stop.start;
      shiftY = stop.shiftY;
    }
  }
  const result = output.createImageData(w, h);
  for (let top = 0; top < h; top += stripRows) {
    const rows = Math.min(stripRows, h - top);
    input.resetTransform();
    input.clearRect(0, 0, strip.width, strip.height);
    input.setTransform(
      scale,
      0,
      0,
      scale,
      phaseX * scale,
      (phaseY - top) * scale,
    );
    input.fill(path, fillRule);
    const data = input.getImageData(0, 0, strip.width, rows * scale).data;
    for (let y = 0; y < rows; y++) {
      const totals = new Uint32Array(w);
      for (let j = 0; j < scale; j++) {
        let pixel = 4 * (y * scale + j) * strip.width + 3;
        for (let x = 0; x < w; x++) {
          let sum = 0;
          for (let i = 0; i < scale; i++, pixel += 4) sum += data[pixel];
          totals[x] += sum;
        }
      }
      for (let x = 0; x < w; x++) {
        const alpha = Math.round((16 * totals[x]) / (255 * samples));
        const at = 4 * ((top + y) * w + x);
        result.data[at] = result.data[at + 1] = result.data[at + 2] = 255;
        result.data[at + 3] = Math.round((255 * alpha) / 16);
      }
    }
  }
  output.putImageData(result, 0, 0);
  const uri = image.toDataURL("image/png");
  outlineCoverageCache.set(key, uri);
  outlineCoverageBytes += key.length + uri.length;
  for (const [oldKey, oldUri] of outlineCoverageCache) {
    if (outlineCoverageBytes <= 4 * 1024 * 1024) break;
    outlineCoverageCache.delete(oldKey);
    outlineCoverageBytes -= oldKey.length + oldUri.length;
  }
  return uri;
}
function TextWithSourceGlyphs({
  text,
  shape,
  style,
}: {
  text: string;
  shape: NonNullable<
    RuntimeNode["sourceTextShape"] | RuntimeNode["sourceTextLayout"]
  >;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [matches, setMatches] = useState(true);
  const [coverage, setCoverage] = useState<string>();
  const maskId = useId();
  const vectorRef = useRef<SVGPathElement>(null);
  const [phase, setPhase] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const check = () => {
      if ("lines" in shape) setPhase(svgTextPhase(parent));
      else {
        const box = parent.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const transform = vectorRef.current?.getScreenCTM();
        const native =
          transform &&
          Math.abs(transform.b) + Math.abs(transform.c) < 0.0001 &&
          Math.abs(box.width * dpr - shape.width) < 0.05 &&
          Math.abs(box.height * dpr - shape.height) < 0.05;
        const phase = svgTextPhase(parent);
        const ink = vectorRef.current?.getBBox();
        const contained =
          ink &&
          ink.x >= 0 &&
          ink.y >= 0 &&
          ink.x + ink.width <= shape.width &&
          ink.y + ink.height <= shape.height;
        let image;
        if (native && contained) {
          try {
            image = outlineCoverage(
              shape.d,
              shape.width,
              shape.height,
              phase.x * Math.sign(transform.a),
              phase.y * Math.sign(transform.d) - 1 / 16,
              shape.coverageOffsets,
            );
          } catch {
            // Privacy controls or hardware limits can deny a raster read. Keep the original vector.
          }
        }
        setCoverage(image);
      }
      setMatches(
        Math.abs(parent.clientWidth - shape.width) <= 1 &&
          Math.abs(parent.clientHeight - shape.height) <= 1,
      );
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(parent);
    const camera = parent.closest('.canvas-world,[style*="transform: scale("]');
    const zoom = camera && new MutationObserver(check);
    if (camera && zoom)
      zoom.observe(camera, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
      zoom?.disconnect();
    };
  }, [shape.width, shape.height, "d" in shape ? shape.d : undefined]);
  return (
    <>
      <span ref={ref} style={{ ...style, opacity: matches ? 0 : undefined }}>
        {text}
      </span>
      {matches && (
        <svg
          data-source-glyphs=""
          aria-hidden="true"
          width={shape.width}
          height={shape.height}
          viewBox={`0 0 ${shape.width} ${shape.height}`}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            pointerEvents: "none",
          }}
        >
          {"lines" in shape ? (
            <NativeTextLines layout={shape} phase={phase} />
          ) : (
            <>
              <path
                ref={vectorRef}
                d={shape.d}
                fill="currentColor"
                opacity={coverage ? 0 : 1}
              />
              {coverage && (
                <>
                  <mask
                    id={maskId}
                    maskUnits="userSpaceOnUse"
                    x={0}
                    y={0}
                    width={Math.ceil(shape.width)}
                    height={Math.ceil(shape.height)}
                  >
                    <image
                      href={coverage}
                      width={Math.ceil(shape.width)}
                      height={Math.ceil(shape.height)}
                    />
                  </mask>
                  <rect
                    width={Math.ceil(shape.width)}
                    height={Math.ceil(shape.height)}
                    fill="currentColor"
                    mask={`url(#${maskId})`}
                  />
                </>
              )}
            </>
          )}
        </svg>
      )}
    </>
  );
}

// Keep the selectable DOM text responsible for wrapping. Clip backdrop effects and
// multiple fill passes to the same shaped lines, including their selected font.
function PaintedText({
  text,
  parts,
  style,
  inkPaints,
  inkShadows,
  sourceTextLayout,
  sourceTextShape,
  backdrop,
}: Pick<
  RuntimeNode,
  | "text"
  | "parts"
  | "inkPaints"
  | "inkShadows"
  | "sourceTextLayout"
  | "sourceTextShape"
> & {
  style?: CSSProperties;
  backdrop?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null),
    clip = useId();
  const [usesLayout, setUsesLayout] = useState(false);
  const [phase, setPhase] = useState({ x: 0, y: 0 });
  const [lines, setLines] = useState<
    {
      x: number;
      y: number;
      width: number;
      text: string;
      style: CSSProperties;
    }[]
  >([]);
  useLayoutEffect(() => {
    const span = ref.current,
      box = span?.parentElement;
    if (!span || !box) return;
    let alive = true;
    const measure = () => {
      if (!alive || !box.offsetWidth || !box.offsetHeight) return;
      if (sourceTextLayout) setPhase(svgTextPhase(box));
      const source = sourceTextLayout ?? sourceTextShape;
      setUsesLayout(
        !!source &&
          Math.abs(box.clientWidth - source.width) <= 1 &&
          Math.abs(box.clientHeight - source.height) <= 1,
      );
      const bounds = box.getBoundingClientRect(),
        sx = bounds.width / box.offsetWidth,
        sy = bounds.height / box.offsetHeight;
      if (!sx || !sy) return;
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      const result: typeof lines = [];
      for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
        const str = leaf.textContent || "",
          css = getComputedStyle(leaf.parentElement!);
        context.font =
          css.fontStyle +
          " " +
          css.fontWeight +
          " " +
          css.fontSize +
          " " +
          css.fontFamily;
        const metrics = context.measureText("Hg");
        const range = document.createRange();
        function add(start: number, end: number) {
          if (end <= start) return;
          range.setStart(leaf!, start);
          range.setEnd(leaf!, end);
          const r = range.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const naturalHeight =
            metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
          result.push({
            text: str.slice(start, end),
            width: r.width / sx,
            x: (r.left - bounds.left) / sx,
            y:
              (r.top - bounds.top) / sy +
              (r.height / sy - naturalHeight) / 2 +
              metrics.fontBoundingBoxAscent,
            style: {
              fontFamily: css.fontFamily,
              fontSize: css.fontSize,
              fontWeight: css.fontWeight,
              fontStyle: css.fontStyle,
              fontVariationSettings: css.fontVariationSettings,
              fontFeatureSettings: css.fontFeatureSettings,
              letterSpacing: css.letterSpacing,
              whiteSpace: "pre",
            },
          });
        }
        range.selectNodeContents(leaf);
        if (range.getClientRects().length <= 1) {
          add(0, str.length);
          continue;
        }
        // Find each browser-wrapped line by bisection, preserving ligatures inside a line.
        for (let start = 0; start < str.length;) {
          if (str[start] === "\n") {
            start++;
            continue;
          }
          const newline = str.indexOf("\n", start);
          let lo = start + 1,
            hi = newline < 0 ? str.length : newline;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            range.setStart(leaf, start);
            range.setEnd(leaf, mid);
            if (range.getClientRects().length <= 1) lo = mid;
            else hi = mid - 1;
          }
          add(start, lo);
          start = lo;
        }
      }
      setLines(result);
    };
    measure();
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => {
      alive = false;
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [text, parts, sourceTextLayout, sourceTextShape, style?.textBoxTrim]);
  const clipped: CSSProperties = {
    position: "absolute",
    inset: 0,
    clipPath: `url(#${clip})`,
    pointerEvents: "none",
  };
  const glyphs =
    usesLayout && sourceTextLayout ? (
      <NativeTextLines layout={sourceTextLayout} phase={phase} />
    ) : usesLayout && sourceTextShape ? (
      <path d={sourceTextShape.d} fill="currentColor" />
    ) : (
      lines.map((line, i) => (
        <text
          key={i}
          x={line.x}
          y={line.y}
          textLength={line.width}
          lengthAdjust="spacingAndGlyphs"
          style={line.style}
        >
          {line.text}
        </text>
      ))
    );
  const shadows = (inset: boolean) =>
    inkShadows
      ?.map((shadow, i) => {
        if (shadow.inset !== inset || !lines.length) return null;
        const filter = clip + "-shadow-" + i;
        const blend =
          shadow.blendMode === "pass-through"
            ? undefined
            : (shadow.blendMode as CSSProperties["mixBlendMode"]);
        const subtract =
          blend === "plus-darker" && /^#([a-f\d]{2})\1\1$/i.test(shadow.color)
            ? 1 - parseInt(shadow.color.slice(1, 3), 16) / 255
            : undefined;
        const shadowFilter = (
          <filter
            id={filter}
            x="-150%"
            y="-150%"
            width="400%"
            height="400%"
            colorInterpolationFilters="sRGB"
          >
            {shadow.spread !== 0 && (
              <feMorphology
                in="SourceAlpha"
                operator={shadow.spread > 0 !== inset ? "dilate" : "erode"}
                radius={Math.abs(shadow.spread)}
                result="spread"
              />
            )}
            <feGaussianBlur
              in={shadow.spread ? "spread" : "SourceAlpha"}
              stdDeviation={shadow.blur / 2}
            />
            <feOffset dx={shadow.x} dy={shadow.y} result="offset" />
            {subtract !== undefined && !inset && (
              <feComposite
                in="offset"
                in2="SourceAlpha"
                operator="out"
                result="exterior"
              />
            )}
            {inset && (
              <feComposite
                in="SourceAlpha"
                in2="offset"
                operator="out"
                result="inner"
              />
            )}
            <feFlood
              floodColor={subtract !== undefined ? "white" : shadow.color}
              floodOpacity={shadow.opacity}
            />
            <feComposite
              in2={
                inset ? "inner" : subtract !== undefined ? "exterior" : "offset"
              }
              operator="in"
            />
          </filter>
        );
        if (subtract !== undefined) {
          const mask = filter + "-mask";
          const extent = Math.ceil(
            Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) +
              shadow.blur * 2 +
              Math.abs(shadow.spread),
          );
          const adjust = 1 + 2 * subtract,
            backdropFilter = `brightness(${1 / adjust}) contrast(${adjust})`;
          return (
            <span
              aria-hidden="true"
              key={filter}
              style={{
                position: "absolute",
                inset: -extent,
                pointerEvents: "none",
              }}
            >
              <svg
                aria-hidden="true"
                width="100%"
                height="100%"
                style={{ position: "absolute", inset: 0, color: "black" }}
              >
                <defs>
                  {shadowFilter}
                  <mask
                    id={mask}
                    maskUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                    style={{ maskType: "alpha" }}
                  >
                    <g transform={`translate(${extent},${extent})`}>
                      <g filter={`url(#${filter})`}>{glyphs}</g>
                    </g>
                  </mask>
                </defs>
              </svg>
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  maskImage: `url(#${mask})`,
                  WebkitMaskImage: `url(#${mask})`,
                  backdropFilter,
                  WebkitBackdropFilter: backdropFilter,
                }}
              />
            </span>
          );
        }
        return (
          <svg
            key={filter}
            aria-hidden="true"
            width="100%"
            height="100%"
            style={{
              position: "absolute",
              inset: 0,
              overflow: "visible",
              pointerEvents: "none",
              mixBlendMode: blend,
              color: "black",
            }}
          >
            <defs>{shadowFilter}</defs>
            <g filter={`url(#${filter})`}>{glyphs}</g>
          </svg>
        );
      })
      .reverse();
  return (
    <>
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: "absolute", pointerEvents: "none" }}
      >
        <defs>
          <clipPath id={clip} clipPathUnits="userSpaceOnUse">
            {glyphs}
          </clipPath>
        </defs>
      </svg>
      {shadows(false)}
      {backdrop && (
        <span
          aria-hidden="true"
          style={{
            ...clipped,
            backdropFilter: backdrop,
            WebkitBackdropFilter: backdrop,
          }}
        />
      )}
      <span
        ref={ref}
        style={{
          ...style,
          ...((inkPaints?.length && lines.length) || usesLayout
            ? { opacity: 0 }
            : {}),
        }}
      >
        {parts
          ? parts.map((p, i) => (
              <span key={i} style={p.style}>
                {p.text}
              </span>
            ))
          : text}
        {(!text || text.endsWith("\n")) && <br />}
      </span>
      {usesLayout && !inkPaints?.length && (
        <svg
          aria-hidden="true"
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          {glyphs}
        </svg>
      )}
      {lines.length > 0 &&
        inkPaints?.map((p, i) => (
          <span
            key={i}
            aria-hidden="true"
            style={{
              ...clipped,
              background: p.background,
              mixBlendMode: p.blend,
              backdropFilter: p.backdropFilter,
              WebkitBackdropFilter: p.backdropFilter,
              opacity: p.opacity,
            }}
          />
        ))}
      {shadows(true)}
    </>
  );
}

export function LayerText({
  text,
  parts,
  sourceTextShape,
  sourceTextLayout,
  inkPaints,
  inkShadows,
  backdrop,
  style,
}: Pick<
  RuntimeNode,
  | "text"
  | "parts"
  | "sourceTextShape"
  | "sourceTextLayout"
  | "inkPaints"
  | "inkShadows"
> & {
  backdrop?: string;
  style?: CSSProperties;
}) {
  if (backdrop || inkPaints?.length || inkShadows?.length) {
    return (
      <PaintedText
        text={text}
        parts={parts}
        style={style}
        backdrop={backdrop}
        sourceTextLayout={
          sourceTextLayout?.text === text && !parts?.length
            ? sourceTextLayout
            : undefined
        }
        sourceTextShape={
          sourceTextShape?.text === text && !parts?.length
            ? sourceTextShape
            : undefined
        }
        inkPaints={inkPaints}
        inkShadows={inkShadows}
      />
    );
  }
  const sourceGlyphs = sourceTextLayout ?? sourceTextShape;
  if (sourceGlyphs && text === sourceGlyphs.text && !parts?.length) {
    return (
      <TextWithSourceGlyphs text={text} shape={sourceGlyphs} style={style} />
    );
  }
  return (
    <span style={style}>
      {parts
        ? parts.map((part, i) => (
            <span key={i} style={part.style}>
              {part.text}
            </span>
          ))
        : text}
      {(!text || text.endsWith("\n")) && <br />}
    </span>
  );
}
function MaskScope({
  mask,
  children,
}: {
  mask: NonNullable<RuntimeNode["siblingMask"]>;
  children: ReactNode;
}) {
  const images = useContext(ImageResources),
    src =
      mask.source ?? (mask.assetId ? images[mask.assetId]?.data : undefined);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        ...mask.style,
        ...(src ? { maskImage: `url(${JSON.stringify(src)})` } : {}),
      }}
    >
      {children}
    </div>
  );
}
export function maskSiblings(
  items: {
    id: string;
    mask?: RuntimeNode["siblingMask"];
    content: ReactNode;
  }[],
) {
  if (!items.some((i) => i.mask)) return items.map((i) => i.content);
  const results: ReactNode[] = [];
  let range: ReactNode[] = [];
  let source: (typeof items)[number] | undefined;
  const finish = () => {
    if (source?.mask)
      results.push(
        <MaskScope key={source.id} mask={source.mask}>
          {range}
        </MaskScope>,
      );
    else results.push(...range);
    range = [];
  };
  for (const item of items) {
    if (item.mask) {
      finish();
      source = item;
    } else range.push(item.content);
  }
  finish();
  return results;
}
// SVG filter inputs inherit CSS variables from the owning node. Arithmetic
// blends use opaque RGB, then apply the two source alphas as in source-over.
function BlendedPaints({
  paints,
}: {
  paints: NonNullable<RuntimeNode["blendedPaints"]>;
}) {
  const id = useId();
  return (
    <svg
      aria-hidden="true"
      width="100%"
      height="100%"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        borderRadius: "inherit",
      }}
    >
      <defs>
        <filter
          id={id}
          x="0"
          y="0"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodColor={paints[0].color} result="layer0" />
          {paints.slice(1).map(({ color, mode }, index) => {
            const previous = "layer" + index,
              result = "layer" + (index + 1);
            const additive = mode === "plus-darker" || mode === "plus-lighter";
            return (
              <Fragment key={result}>
                <feFlood floodColor={color} result="ink" />
                {additive ? (
                  <>
                    <feComponentTransfer in="ink" result="ink-rgb">
                      <feFuncA type="linear" slope={0} intercept={1} />
                    </feComponentTransfer>
                    <feComponentTransfer in={previous} result="back-rgb">
                      <feFuncA type="linear" slope={0} intercept={1} />
                    </feComponentTransfer>
                    <feComposite
                      in="ink-rgb"
                      in2="back-rgb"
                      operator="arithmetic"
                      k2={1}
                      k3={1}
                      k4={mode === "plus-darker" ? -1 : 0}
                      result="rgb"
                    />
                    <feComposite
                      in="rgb"
                      in2={previous}
                      operator="in"
                      result="overlap"
                    />
                    <feComposite
                      in="overlap"
                      in2="ink-rgb"
                      operator="over"
                      result="source-rgb"
                    />
                    <feComposite
                      in="source-rgb"
                      in2="ink"
                      operator="in"
                      result="source"
                    />
                    <feComposite
                      in="source"
                      in2={previous}
                      operator="over"
                      result={result}
                    />
                  </>
                ) : (
                  <feBlend
                    in="ink"
                    in2={previous}
                    mode={
                      (mode ||
                        "normal") as React.SVGProps<SVGFEBlendElement>["mode"]
                    }
                    result={result}
                  />
                )}
              </Fragment>
            );
          })}
        </filter>
      </defs>
      <rect width="1" height="1" filter={`url(#${id})`} />
    </svg>
  );
}
// CSS blur of a subpixel plate differs across WebKit, Gecko and Chromium.
// Integrate the live rounded plate's coverage then apply the source Gaussian
// separately in each axis. Large or stretched scenes keep the scalable CSS path.
const glassMaskCache = new Map<string, string>();
let glassMaskCacheBytes = 0;
function sampledPlateMask(
  lensWidth: number,
  lensHeight: number,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
  sigma: number,
  density: number,
) {
  const outWidth = Math.ceil(lensWidth * density),
    outHeight = Math.ceil(lensHeight * density);
  const extent = Math.ceil(3.5 * sigma * density),
    w = outWidth + extent * 2,
    h = outHeight + extent * 2;
  if (!(
    outWidth > 0 &&
    outHeight > 0 &&
    extent > 0 &&
    w * h <= 200000 &&
    extent <= 80 &&
    extent * w * h <= 7e6
  ))
    return;
  const key = [
    outWidth,
    outHeight,
    left,
    top,
    width,
    height,
    radius,
    sigma,
    density,
  ].join(",");
  const existing = glassMaskCache.get(key);
  if (existing) return existing;
  left *= density;
  top *= density;
  width *= density;
  height *= density;
  const r = Math.min(radius * density, width / 2, height / 2);
  const distance = (x: number, y: number) => {
    const dx = Math.max(left + r - x, x - (left + width - r));
    const dy = Math.max(top + r - y, y - (top + height - r));
    return (
      Math.hypot(Math.max(0, dx), Math.max(0, dy)) +
      Math.min(Math.max(dx, dy), 0) -
      r
    );
  };
  const coverage = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = i - extent + 0.5,
        y = j - extent + 0.5,
        d = distance(x, y);
      if (d <= -Math.SQRT1_2) coverage[j * w + i] = 1;
      else if (d < Math.SQRT1_2) {
        let count = 0;
        for (let sy = 0; sy < 8; sy++)
          for (let sx = 0; sx < 8; sx++)
            if (
              distance(x + (sx + 0.5) / 8 - 0.5, y + (sy + 0.5) / 8 - 0.5) <= 0
            )
              count++;
        coverage[j * w + i] = count / 64;
      }
    }
  const kernel = Array.from({ length: extent * 2 + 1 }, (_, i) =>
    Math.exp(-0.5 * ((i - extent) / (sigma * density)) ** 2),
  );
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const horizontal = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = extent; i < w - extent; i++) {
      let alpha = 0;
      for (let k = -extent; k <= extent; k++)
        alpha += coverage[j * w + i + k] * kernel[k + extent];
      horizontal[j * w + i] = alpha;
    }
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const pixels = ctx.createImageData(outWidth, outHeight);
  for (let j = 0; j < outHeight; j++)
    for (let i = 0; i < outWidth; i++) {
      let alpha = 0;
      for (let k = -extent; k <= extent; k++)
        alpha +=
          horizontal[(j + extent + k) * w + i + extent] * kernel[k + extent];
      pixels.data[4 * (j * outWidth + i) + 3] = Math.round(alpha * 255);
    }
  ctx.putImageData(pixels, 0, 0);
  const uri = canvas.toDataURL("image/png");
  glassMaskCache.set(key, uri);
  glassMaskCacheBytes += uri.length;
  for (const [old, entry] of glassMaskCache) {
    if (glassMaskCacheBytes <= 2 * 1024 * 1024 && glassMaskCache.size <= 256)
      break;
    glassMaskCache.delete(old);
    glassMaskCacheBytes -= entry.length;
  }
  return uri;
}
export function GlassFace({ sample }: { sample: GlassSample }) {
  const layer = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const lens = layer.current?.parentElement,
      ink = layer.current?.firstElementChild as HTMLElement | undefined;
    if (!lens || !ink) return;
    let source = lens.parentElement;
    while (
      source &&
      source.dataset.designId !== sample.ancestor &&
      source.dataset.nodeId !== sample.ancestor
    )
      source = source.parentElement;
    if (!source) return;
    const surface = source;
    // Figma can sample a Section's fill through a clear part of the face,
    // including when the designer exports the control in isolation.
    let alreadyPainted = false;
    for (let p = surface.parentElement; p; p = p.parentElement) {
      if (
        p.dataset.designId !== sample.paintedAncestor &&
        p.dataset.nodeId !== sample.paintedAncestor
      )
        continue;
      if (sample.paintedAncestor)
        alreadyPainted = !["transparent", "rgba(0, 0, 0, 0)"].includes(
          getComputedStyle(p).backgroundColor,
        );
      break;
    }
    const environment =
      (sample.capturedEnvironment || sample.environment !== "#ffffff") &&
      !alreadyPainted
        ? document.createElement("span")
        : undefined;
    if (environment) {
      environment.setAttribute("aria-hidden", "true");
      environment.dataset.figmaGlass = "environment";
      Object.assign(environment.style, {
        position: "absolute",
        pointerEvents: "none",
        background: sample.environment,
        margin: 0,
        padding: 0,
      });
      surface.before(environment);
    }
    const update = () => {
      const a = lens.getBoundingClientRect(),
        b = surface.getBoundingClientRect();
      if (!a.width || !a.height) return;
      const sx = lens.offsetWidth / a.width,
        sy = lens.offsetHeight / a.height;
      if (environment) {
        Object.assign(environment.style, {
          left: "0px",
          top: "0px",
          width: lens.offsetWidth + "px",
          height: lens.offsetHeight + "px",
          borderRadius: getComputedStyle(lens).borderRadius,
        });
        const reference = environment.getBoundingClientRect();
        if (reference.width && reference.height) {
          environment.style.left =
            ((a.left - reference.left) * lens.offsetWidth) / reference.width +
            "px";
          environment.style.top =
            ((a.top - reference.top) * lens.offsetHeight) / reference.height +
            "px";
        }
      }
      if (sample.floorOnly) return;
      const left = (b.left - a.left) * sx,
        top = (b.top - a.top) * sy;
      const width = b.width * sx,
        height = b.height * sy;
      const radius = getComputedStyle(surface).borderRadius;
      const density = window.devicePixelRatio / sx;
      let mask: string | undefined;
      if (
        sample.blurSigma &&
        sx > 0 &&
        Math.abs(sx - sy) < 0.001 &&
        /^[-.\d]+px$/.test(radius)
      ) {
        mask = sampledPlateMask(
          lens.offsetWidth,
          lens.offsetHeight,
          left,
          top,
          width,
          height,
          parseFloat(radius),
          sample.blurSigma,
          density,
        );
      }
      Object.assign(
        ink.style,
        mask
          ? {
              left: "0px",
              top: "0px",
              width: "100%",
              height: "100%",
              borderRadius: "0px",
              filter: "none",
              maskImage: 'url("' + mask + '")',
              maskSize: "100% 100%",
              maskRepeat: "no-repeat",
            }
          : {
              left: left + "px",
              top: top + "px",
              width: width + "px",
              height: height + "px",
              borderRadius: radius,
              filter: sample.source.filter ?? "",
              maskImage: "none",
            },
      );
    };
    update();
    const resize = new ResizeObserver(update);
    const move = new MutationObserver(update);
    for (
      let ancestor: HTMLElement | null = lens;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      resize.observe(ancestor);
      move.observe(ancestor, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
      if (ancestor === surface) break;
    }
    return () => {
      move.disconnect();
      resize.disconnect();
      environment?.remove();
    };
  }, [sample]);
  return (
    <>
      <span
        aria-hidden="true"
        data-figma-glass="sample"
        style={sample.layer}
        ref={layer}
      >
        <span style={sample.source} />
      </span>
      <span aria-hidden="true" style={sample.face} />
    </>
  );
}
export function LinearBurn({
  paint,
}: {
  paint: NonNullable<RuntimeNode["boxBurn"]>;
}) {
  const layers =
    typeof CSS !== "undefined" && CSS.supports("mix-blend-mode", "plus-darker")
      ? [paint.native]
      : paint.layers;
  return layers.map((ink, i) => (
    <span key={i} aria-hidden="true" style={{ ...paint.shape, ...ink }} />
  ));
}
export function BoxShadows({ layers }: { layers?: CSSProperties[] }) {
  return layers?.map((style, i) => (
    <span key={i} aria-hidden="true" style={style} />
  ));
}
export function ImagePaint({
  paint,
  source,
  overlay,
}: {
  paint: NonNullable<RuntimeNode["image"]>;
  source?: string;
  overlay?: string;
}) {
  const resources = useContext(ImageResources);
  const src = source ?? paint.source ?? resources[paint.assetId]?.data;
  if (!src && !overlay) return null;
  const position = paint.x + "% " + paint.y + "%";
  const rotate =
    paint.transform ?? (paint.rotation ? `rotate(${paint.rotation}deg)` : "");
  const imgTransform = [rotate, "scale(" + paint.zoom + ")"]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      aria-hidden="true"
      style={{
        display: "block",
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        borderRadius: "inherit",
        pointerEvents: "none",
        zIndex: overlay ? -1 : undefined,
      }}
    >
      {src &&
        (paint.fit === "tile" ? (
          <span
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url(${JSON.stringify(src)})`,
              backgroundRepeat: "repeat",
              backgroundSize: paint.tileSize?.map((n) => n + "px").join(" "),
              backgroundPosition: position,
              filter: paint.filter,
              opacity: paint.opacity,
              ...(rotate
                ? { transform: rotate, transformOrigin: "center" }
                : {}),
            }}
          />
        ) : (
          <img
            src={src}
            alt=""
            draggable={false}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              filter: paint.filter,
              opacity: paint.opacity,
              objectFit: paint.fit,
              objectPosition: position,
              transform: imgTransform,
              transformOrigin: rotate ? "center" : position,
            }}
          />
        ))}
      {overlay && (
        <span style={{ position: "absolute", inset: 0, background: overlay }} />
      )}
    </span>
  );
}
export const InteractionContext = createContext<{
  wired: ReadonlySet<string>;
  rules?: Record<string, { trigger?: "click" | "hover" | "delay" }>;
  multiRules?: Record<string, { trigger?: "click" | "hover" | "delay" }[]>;
  controls: Record<string, ControlValue>;
  changes: Record<string, ControlValue>;
} | null>(null);
export function vectorFillMask(
  vector: NonNullable<RuntimeNode["vector"]>,
): CSSProperties | undefined {
  if (!vector.fillFromStyle) return;
  const outlines = vector.paths
    .filter((p) => p.fill && !p.fillColor)
    .map(
      (p) =>
        `<path d="${p.d}" fill-rule="${p.fillRule ?? "nonzero"}" opacity="${(p.fillOpacity ?? 1) * (p.opacity ?? 1)}"/>`,
    )
    .join("");
  if (!outlines) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vector.width} ${vector.height}" preserveAspectRatio="${vector.stretch ? "none" : "xMidYMid meet"}">${outlines}</svg>`;
  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background: "var(--forma-vector-fill,transparent)",
    maskImage: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")',
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
  };
}
export function VectorPaint({
  vector,
  children,
  fallback,
}: {
  fallback?: CSSProperties;
  vector: NonNullable<RuntimeNode["vector"]>;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const axes = useRef<SVGSVGElement>(null);
  const [coverage, setCoverage] = useState<string>();
  const paths = vector.paths.filter((p) => p.fill && !p.fillColor);
  const path = paths.length === 1 ? paths[0] : undefined;
  const w = vector.width,
    h = vector.height;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => {
      let image;
      const b = element.getBoundingClientRect();
      const ctm =
        axes.current?.getScreenCTM() ??
        element.parentElement
          ?.querySelector<SVGSVGElement>(":scope > svg")
          ?.getScreenCTM();
      const dpr = window.devicePixelRatio || 1;
      if (
        path &&
        w > 0 &&
        h > 0 &&
        w * h <= 8192 &&
        !((path.opacity ?? 1) < 1 || (path.fillOpacity ?? 1) < 1) &&
        ctm &&
        ctm.a > 0 &&
        ctm.d > 0 &&
        Math.abs(ctm.b) + Math.abs(ctm.c) < 0.0001 &&
        Math.abs(b.width * dpr - w) < 0.01 &&
        Math.abs(b.height * dpr - h) < 0.01 &&
        Math.abs(b.x * dpr - Math.round(b.x * dpr)) < 0.01 &&
        Math.abs(b.y * dpr - Math.round(b.y * dpr)) < 0.01
      ) {
        try {
          image = outlineCoverage(path.d, w, h, 0, 0, undefined, path.fillRule);
        } catch {
          /* Keep the scalable SVG when raster readback is unavailable. */
        }
      }
      setCoverage(image);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    const camera = element.closest(
      '.canvas-world,[style*="transform: scale("]',
    );
    const zoom = camera && new MutationObserver(check);
    if (camera && zoom)
      zoom.observe(camera, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
      zoom?.disconnect();
    };
  }, [path?.d, path?.fillRule, path?.opacity, path?.fillOpacity, w, h]);
  const style = fallback || vectorFillMask(vector);
  if (!style) return null;
  return (
    <span
      ref={ref}
      aria-hidden="true"
      style={
        coverage
          ? {
              ...style,
              borderRadius: 0,
              maskImage: 'url("' + coverage + '")',
              maskSize: "100% 100%",
              maskRepeat: "no-repeat",
            }
          : style
      }
    >
      {fallback && (
        <svg
          ref={axes}
          width={1}
          height={1}
          aria-hidden="true"
          style={{ position: "absolute", pointerEvents: "none" }}
        />
      )}
      {children}
    </span>
  );
}
export function CapsulePaint({
  capsule,
}: {
  capsule: NonNullable<RuntimeNode["capsule"]>;
}) {
  const { d, width, height, background } = capsule;
  return (
    <VectorPaint
      vector={{
        width,
        height,
        fillFromStyle: true,
        paths: [{ d, fill: true, strokeWidth: 0 }],
      }}
      fallback={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        background,
        borderRadius: "99999px",
      }}
    />
  );
}
export function vectorPathProps(
  path: NonNullable<RuntimeNode["vector"]>["paths"][number],
  fillFromStyle = false,
) {
  return {
    d: path.d,
    fill: path.fill
      ? (path.fillColor ?? (fillFromStyle ? "none" : "currentColor"))
      : "none",
    stroke: path.strokeWidth ? (path.strokeColor ?? "currentColor") : "none",
    strokeWidth: path.strokeWidth,
    style: {
      strokeWidth: `var(--forma-vector-stroke-width, ${path.strokeWidth}px)`,
    },
    fillRule: path.fillRule,
    opacity: path.opacity,
    fillOpacity: path.fillOpacity,
    strokeOpacity: path.strokeOpacity,
    strokeLinecap: path.lineCap ?? "round",
    strokeLinejoin: path.lineJoin ?? "round",
  };
}
function Vector({ node }: { node: RuntimeNode }) {
  return node.vector ? (
    <>
      {node.vector.fillFromStyle && (
        <VectorPaint vector={node.vector}>
          {node.blendedPaints && <BlendedPaints paints={node.blendedPaints} />}
        </VectorPaint>
      )}
      <svg
        width={node.style.width === 0 ? node.vector.width : "100%"}
        height={node.style.height === 0 ? node.vector.height : "100%"}
        preserveAspectRatio={node.vector.stretch ? "none" : undefined}
        viewBox={`0 0 ${node.vector.width} ${node.vector.height}`}
        overflow={node.vector.overflowVisible ? "visible" : undefined}
        aria-hidden="true"
        style={{ display: "block" }}
      >
        {node.vector.paths.map((p, i) => (
          <path key={i} {...vectorPathProps(p, node.vector!.fillFromStyle)} />
        ))}
      </svg>
    </>
  ) : null;
}
/** The design width is the layout border box, independent of canvas zoom. */
export function useContainerLayout(rule: RuntimeNode["gridBreakpoint"]) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  const enabled = !!rule;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    setWidth(el.offsetWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.borderBoxSize?.[0]?.inlineSize ?? el.offsetWidth),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled]);
  const active =
    width === undefined
      ? undefined
      : rule?.rules.find((r) => width <= r.maxWidth);
  const style: RuntimeNode["style"] = {};
  if (rule && active) {
    const { columns, padding, gap, rowGap } = active;
    if (columns !== undefined) {
      style[rule.variable as `--${string}`] = String(columns);
      style[(rule.variable + "-tracks") as `--${string}`] =
        "repeat(" + columns + ",minmax(0,1fr))";
    }
    if (active.radius !== undefined) style.borderRadius = active.radius;
    if (active.opacity !== undefined) style.opacity = active.opacity;
    if (active.fill !== undefined) style.background = active.fill;
    if (padding !== undefined) style.padding = padding;
    if (gap !== undefined) {
      style.columnGap = gap;
      if (!rule.hasExplicitRowGap) style.rowGap = gap;
    }
    if (rowGap !== undefined) style.rowGap = rowGap;
  }
  function apply<T extends CSSProperties>(base: T): CSSProperties {
    if (!rule && base.gap === undefined) return base;
    // React cannot restore a shorthand after it has cleared an overlapping longhand.
    const { gap, ...rest } = base;
    return {
      ...rest,
      columnGap: base.columnGap ?? gap,
      rowGap: base.rowGap ?? gap,
      ...style,
    };
  }
  return { ref, apply };
}

export type DesignNodeProps = { node: RuntimeNode; onAction?: DesignAction };
export const DesignComponents = createContext<
  Record<string, ComponentType<DesignNodeProps>>
>({});
export function DesignNodeView(props: DesignNodeProps) {
  const components = useContext(DesignComponents);
  const Component = props.node.component && components[props.node.component];
  return Component ? (
    <Component {...props} />
  ) : (
    <DesignNodeContent {...props} />
  );
}
export function instanceTemplate(
  node: RuntimeNode,
  instanceId: string,
  text: Record<string, string> = {},
  visibility: Record<string, boolean> = {},
  slots: Record<string, ReactNode> = {},
): RuntimeNode {
  function build(layer: RuntimeNode, root: boolean): RuntimeNode {
    const override =
      layer.key !== undefined && Object.hasOwn(text, layer.key)
        ? text[layer.key]
        : undefined;
    const visible =
      layer.key === undefined
        ? undefined
        : Object.hasOwn(visibility, layer.key)
          ? visibility[layer.key]
          : undefined;
    return {
      ...layer,
      id: root ? instanceId : instanceId + "/" + (layer.key ?? layer.id),
      ...(override === undefined ? {} : { text: override, parts: undefined }),
      ...(layer.key !== undefined && Object.hasOwn(slots, layer.key)
        ? { slotContent: slots[layer.key] }
        : {}),
      style: {
        ...layer.style,
        ...(root ? { position: "relative", left: 0, top: 0 } : {}),
        ...(visible === undefined
          ? {}
          : {
              display: visible
                ? (layer.visibleDisplay ?? layer.style.display)
                : "none",
            }),
      },
      children: layer.children.map((child) => build(child, false)),
    };
  }
  return build(node, true);
}
export function DesignNodeContent({
  node,
  onAction,
}: {
  node: RuntimeNode;
  onAction?: DesignAction;
}) {
  const layout = useContainerLayout(node.gridBreakpoint);
  const c = node.control;
  const session = useContext(InteractionContext);
  const [localValue, setValue] = useState<ControlValue>(c?.value ?? "");
  const [localActivated, setActivated] = useState(false);
  const remote = session?.controls[node.id];
  const value = remote ?? localValue,
    activated = remote !== undefined || localActivated;
  const wired = session?.wired.has(node.id);
  const nodeRules =
    session?.multiRules?.[node.id] ??
    (session?.rules?.[node.id] ? [session.rules[node.id]] : []);
  const hasClick = nodeRules.some((r) => (r.trigger ?? "click") === "click");
  const hasHover = nodeRules.some((r) => r.trigger === "hover");
  const hotspot = !c && wired && hasClick;
  if (node.type === "slice") return null;
  if (node.type === "section")
    return (
      <>
        {node.children.map((child) => (
          <DesignNodeView node={child} key={child.id} onAction={onAction} />
        ))}
      </>
    );
  const change = (next: string | number | boolean) => {
    if (c?.disabled) return;
    setActivated(true);
    setValue(next);
    onAction?.(node.id, next);
  };
  const width = node.geometry?.width ?? (Number(node.style.width) || 1),
    height = node.geometry?.height ?? (Number(node.style.height) || 1);
  const min = c?.min ?? 0,
    max = c?.max ?? 100,
    step = c?.step ?? 1;
  const fraction = Math.min(
    1,
    Math.max(0, (Number(value) - min) / (max - min || 1)),
  );
  const base = { ...node.style, margin: 0 };
  const overlay =
    node.image && node.slotContent === undefined
      ? separateImageOverlay(base)
      : undefined;
  const style = layout.apply(base);
  if (node.style["--forma-hide-blur"]) delete style.filter;
  if (node.style["--forma-hide-backdrop"]) {
    delete style.backdropFilter;
    delete style.WebkitBackdropFilter;
  }
  const visible =
    node.bindings?.visible && session?.changes[node.bindings.visible];
  if (typeof visible === "boolean")
    style.display = visible
      ? style.WebkitLineClamp
        ? "-webkit-box"
        : node.type === "text" && style.flexDirection === "column"
          ? "flex"
          : (node.bindings?.display ?? "block")
      : "none";
  const boundText = node.bindings?.text && session?.changes[node.bindings.text];
  const text = typeof boundText === "string" ? boundText : node.text;
  if (activated && (c?.kind === "switch" || c?.kind === "checkbox"))
    style.background = value ? c.palette?.accent : c.palette?.track;
  if (activated && c?.kind === "checkbox")
    style.border = value ? 0 : `2px solid ${c.palette?.border ?? "#a0acc0"}`;
  const showPlaceholder =
    c?.kind === "textfield" && c.value === "" && value === "";
  const children = node.children
    .map((child) => {
      const next = { ...child, style: { ...child.style } };
      if (c?.kind === "switch" && child.key === "thumb" && activated)
        next.style.left = value ? width - Number(child.style.width) - 3 : 3;
      if ((c?.kind === "slider" || c?.kind === "progress") && activated) {
        if (child.key === "fill")
          next.style.width = Math.max(0, width * fraction);
        if (child.key === "thumb")
          next.style.left = Math.min(
            width - 28,
            Math.max(0, width * fraction - 14),
          );
        if (child.key === "value") next.text = `${value}%`;
      }
      if (c?.kind === "stepper" && child.key === "value")
        next.text = String(value);
      if (c?.kind === "segmented" && activated) {
        const count = c.options?.length ?? 1,
          segment = (width - 8) / count;
        if (child.key === "active")
          next.style.left = 4 + Number(value) * segment;
        if (child.key?.startsWith("label-")) {
          const selected = Number(child.key.slice(6)) === Number(value);
          next.style.fontWeight = selected ? 600 : 400;
          next.style.color = selected ? node.style.color : undefined;
        }
      }
      return next;
    })
    .filter(
      (child) =>
        !(
          c?.kind === "textfield" &&
          child.key === "value" &&
          !showPlaceholder
        ) && !(c?.kind === "checkbox" && child.key === "check"),
    );
  const visual =
    node.slotContent !== undefined ? (
      node.slotContent
    ) : (
      <>
        {node.blendedPaints &&
          !node.vector?.fillFromStyle &&
          !(activated && (c?.kind === "switch" || c?.kind === "checkbox")) && (
            <BlendedPaints paints={node.blendedPaints} />
          )}
        {node.image && <ImagePaint paint={node.image} overlay={overlay} />}
        {node.glass && <GlassFace sample={node.glass} />}
        {node.boxBurn && <LinearBurn paint={node.boxBurn} />}
        <BoxShadows layers={node.boxPaint} />
        {node.capsule && <CapsulePaint capsule={node.capsule} />}
        <BoxShadows layers={node.strokePaints} />
        <BoxShadows layers={node.boxShadows} />
        <Vector node={node} />
        {(node.type === "text" || text) && (
          <LayerText
            style={
              style.textBoxTrim === "trim-both"
                ? {
                    display: "block",
                    textBoxTrim: "trim-both",
                    textBoxEdge: "cap alphabetic",
                  }
                : undefined
            }
            text={text}
            inkPaints={node.inkPaints}
            inkShadows={node.inkShadows}
            backdrop={
              node.style["--forma-hide-backdrop"]
                ? undefined
                : (node.style["--forma-text-backdrop"] as string | undefined)
            }
            sourceTextLayout={node.sourceTextLayout}
            sourceTextShape={node.sourceTextShape}
            parts={text === node.text ? node.parts : undefined}
          />
        )}
        {maskSiblings(
          children.map((child) => ({
            id: child.id,
            mask: child.siblingMask,
            content: (
              <DesignNodeView node={child} key={child.id} onAction={onAction} />
            ),
          })),
        )}
        {c?.kind === "checkbox" && Boolean(value) && (
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            style={{ position: "absolute", left: 4, top: 4, color: "#ffffff" }}
          >
            <path
              d="M5 12 L10 17 L20 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </>
    );
  const common = { disabled: c?.disabled, "aria-label": c?.label };
  const field = node.children.find((n) => n.key === "value");
  return (
    <div
      ref={layout.ref}
      data-design-id={node.id}
      data-forma-hotspot={
        wired || (c && !c.disabled && c.kind !== "progress") ? "" : undefined
      }
      data-forma-hover={wired && hasHover ? "" : undefined}
      data-component={node.name}
      style={hotspot ? { ...style, cursor: "pointer" } : style}
      {...(hotspot
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": node.name,
            onClick: (e: React.MouseEvent<HTMLDivElement>) => {
              if (
                (e.target as Element).closest("button,input,[role=button]") !==
                e.currentTarget
              )
                return;
              e.stopPropagation();
              onAction?.(node.id, true);
            },
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (
                e.target === e.currentTarget &&
                (e.key === "Enter" || e.key === " ")
              ) {
                e.preventDefault();
                e.stopPropagation();
                onAction?.(node.id, true);
              }
            },
          }
        : {})}
    >
      {c ? (
        <div aria-hidden="true" style={{ display: "contents" }}>
          {visual}
        </div>
      ) : (
        visual
      )}
      {c?.kind === "button" && (
        <button
          {...common}
          type="button"
          style={hitArea}
          onClick={() => change(true)}
        />
      )}
      {(c?.kind === "switch" || c?.kind === "checkbox") && (
        <button
          {...common}
          type="button"
          role={c.kind}
          aria-checked={Boolean(value)}
          style={hitArea}
          onClick={() => change(!value)}
        />
      )}
      {c?.kind === "textfield" && (
        <input
          {...common}
          value={String(value)}
          data-design-id={showPlaceholder ? undefined : field?.id}
          aria-placeholder={c.value === "" ? field?.text : undefined}
          onChange={(e) => change(e.target.value)}
          style={{
            ...field?.style,
            boxSizing: "border-box",
            position: "absolute",
            left: field?.style.left ?? 12,
            top: field?.style.top ?? 0,
            width: field?.style.width ?? width - 24,
            height: field?.style.height ?? height,
            padding: 0,
            border: 0,
            background: "transparent",
            color: node.style.color,
            fontFamily:
              field?.style.fontFamily ?? node.style.fontFamily ?? "inherit",
            outlineOffset: 3,
          }}
        />
      )}
      {c?.kind === "slider" && (
        <input
          {...common}
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(value)}
          onChange={(e) => change(Number(e.target.value))}
          style={{ ...hitArea, opacity: 0.01 }}
        />
      )}
      {c?.kind === "stepper" && (
        <>
          <button
            type="button"
            aria-label={`${c.label} 减少`}
            disabled={c.disabled || Number(value) <= min}
            style={{ ...hitArea, right: undefined, width: 48 }}
            onClick={() => change(Math.max(min, Number(value) - step))}
          />
          <output
            aria-live="polite"
            aria-label={`${c.label} 当前值`}
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              overflow: "hidden",
              clipPath: "inset(50%)",
            }}
          >
            {String(value)}
          </output>
          <button
            type="button"
            aria-label={`${c.label} 增加`}
            disabled={c.disabled || Number(value) >= max}
            style={{ ...hitArea, left: undefined, width: 48 }}
            onClick={() => change(Math.min(max, Number(value) + step))}
          />
        </>
      )}
      {c?.kind === "segmented" && (
        <div
          role="group"
          aria-label={c.label}
          style={{ ...hitArea, display: "flex", padding: 4 }}
        >
          {c.options?.map((label, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={Number(value) === i}
              aria-label={label}
              disabled={c.disabled}
              style={{
                flex: 1,
                border: 0,
                background: "transparent",
                color: "transparent",
                borderRadius: 10,
                cursor: "pointer",
              }}
              onClick={() => change(i)}
            />
          ))}
        </div>
      )}
      {c?.kind === "progress" && (
        <div
          role="progressbar"
          aria-label={c.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Number(value)}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        />
      )}
    </div>
  );
}
