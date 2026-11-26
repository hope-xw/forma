import { strokePaintLayers } from "./stroke-paints";
import {
  exposeSurface,
  sampleGlass,
  sectionGlassBackdrop,
} from "./figma-glass";
import { separateCapsuleFill } from "./capsule-fill";
import { blendedStrokePaint, linearBurnLayer } from "./layer-blend";
import { siblingMaskPaint } from "./svg-export";
import { findLayer, indexPublishedScene } from "../domain/scene-index";
import { independentShadows } from "./material-composite";
import { symbolPaintForView } from "../domain/symbol-background";
import { textInkPaints } from "./paints";
import { nativeDocumentText } from "../domain/document-parts";
import { fontFaceWeight } from "../domain/fonts";
import { currentTextLayout, currentTextShape } from "../domain/text-shape";
import { imagePaint } from "../domain/images";
import { displayNode, displayColor } from "../domain/color-profile";
import { layerComponent } from "../domain/component-slots";
import {
  componentProjectFiles,
  pageComponentImports,
} from "./component-project";
import { gridBreakpoint } from "../domain/sizing";
import {
  exportTokenFiles,
  symbolicNodeCss,
  scopedCssVariables,
  cssVariableName,
  cssTokenValue,
} from "./design-tokens";
import { resolvedDocument, resolveVariable } from "../domain/design-system";
import {
  prototypeIssues,
  linkedPrototypeScene,
  nodeInteractions,
  isSceneFrame,
} from "../domain/prototype";
import type { Program, Rule } from "../runtime/prototype-machine";
import { sizeScene } from "../domain/sizing";
import { currentPageOnly } from "../domain/pages";
import type { CSSProperties } from "react";
import type { DesignDocument, DesignNode } from "../domain/document";
import type { RuntimeNode } from "../runtime/FormaRuntime";
import { nodeCss } from "./react";
import { textParts } from "../domain/rich-text";
import { booleanVector } from "../domain/boolean-shapes";
import { ancestors, subtreeIds } from "../domain/tree";

/**
 * Strip editor-only `slice` nodes and transparently unwrap `section` containers,
 * shifting their children into world coordinates so exported React/Prototype views
 * render section contents without leaking section chrome.
 */
export function unwrapSectionsAndSlices(doc: DesignDocument): DesignDocument {
  if (!doc.nodes.some((n) => n.type === "section" || n.type === "slice"))
    return doc;
  const nodes = doc.nodes
    .filter((n) => n.type !== "slice")
    .map((n) => ({ ...n, style: { ...n.style } }));
  const sections = new Map<string, DesignNode>();
  for (const n of nodes) if (n.type === "section") sections.set(n.id, n);

  // Compute accumulated world offset and hidden state for any chain of section ancestors
  const sectionInfo = (sectionId: string) => {
    let dx = 0;
    let dy = 0;
    let hidden = false;
    let inheritedModes: DesignNode["variableModes"];
    let current: DesignNode | undefined = sections.get(sectionId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      dx += current.style.x;
      dy += current.style.y;
      if (current.hidden) hidden = true;
      if (current.variableModes)
        inheritedModes = { ...current.variableModes, ...inheritedModes };
      current = current.parentId ? sections.get(current.parentId) : undefined;
    }
    return { dx, dy, hidden, inheritedModes };
  };

  const unwrapped: DesignNode[] = [];
  const glassInFile = nodes.some((n) => n.style.figmaGlass?.visible);
  const environment = new Map<
    string,
    ReturnType<typeof sectionGlassBackdrop>
  >();
  for (const n of nodes) {
    if (n.type === "section") continue;
    if (n.parentId && sections.has(n.parentId)) {
      const info = sectionInfo(n.parentId);
      if (info.inheritedModes)
        n.variableModes = { ...info.inheritedModes, ...n.variableModes };
      if (glassInFile) {
        if (!environment.has(n.parentId))
          environment.set(n.parentId, sectionGlassBackdrop(doc, n.parentId));
        const field = environment.get(n.parentId)!;
        n.style.glassEnvironment = field.glassEnvironment;
        if (field.glassSampleEnvironment)
          n.style.glassSampleEnvironment = field.glassSampleEnvironment;
        else delete n.style.glassSampleEnvironment;
      }
      n.parentId = null;
      n.style.x += info.dx;
      n.style.y += info.dy;
      if (info.hidden) n.hidden = true;
    }
    unwrapped.push(n);
  }
  return { ...doc, nodes: unwrapped };
}

export function prototypeProgram(doc: DesignDocument): Program | null {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const hasAnyRule = doc.nodes.some(
    (n) =>
      n.type !== "slice" &&
      n.type !== "section" &&
      nodeInteractions(n).some(
        (rule) =>
          rule.flow ||
          rule.scroll ||
          rule.actions?.length ||
          rule.otherwise?.length,
      ),
  );
  if (!hasAnyRule) return null;
  const issues = prototypeIssues(doc);
  if (issues.length) throw new Error(issues.join("；"));
  const system = doc.designSystem;
  const flows: { id: string; name: string }[] = [];
  for (const n of doc.nodes) {
    if (!isSceneFrame(n, byId)) continue;
    const flowRule = nodeInteractions(n).find((r) => r.flow);
    if (flowRule?.flow) flows.push({ id: n.id, name: flowRule.flow });
  }
  const root =
    doc.nodes.find((n) => isSceneFrame(n, byId)) ??
    doc.nodes.find(
      (n) => !n.parentId && n.type !== "section" && n.type !== "slice",
    );
  if (!flows.length && root) flows.push({ id: root.id, name: root.name });

  const rules: Record<string, Rule> = {};
  const multiRules: Record<string, Rule[]> = {};
  for (const n of doc.nodes) {
    if (n.type === "slice" || n.type === "section") continue;
    const active = nodeInteractions(n).filter(
      (r) => r.actions?.length || r.otherwise?.length,
    );
    if (!active.length) continue;
    rules[n.id] = active[0];
    if (active.length > 1) multiRules[n.id] = active;
  }

  return {
    flows,
    rules,
    ...(Object.keys(multiRules).length ? { multiRules } : {}),
    variables: Object.fromEntries(
      Object.keys(system?.variables ?? {}).map((id) => [
        id,
        resolveVariable(system!, id, system!.activeModes),
      ]),
    ),
    ...(doc.colorProfile === "display-p3"
      ? {
          p3Variables: Object.values(system?.variables ?? {})
            .filter((v) => v.type === "color")
            .map((v) => v.id),
        }
      : {}),
    cssNames: Object.fromEntries(
      Object.keys(system?.variables ?? {}).map((id) => [
        id,
        cssVariableName(system!, id),
      ]),
    ),
  };
}
/** Export a page, not its incidental placement on the editor's infinite canvas. */
export function pageForExport(
  doc: DesignDocument,
  selection: string[] = [],
): DesignDocument {
  doc = unwrapSectionsAndSlices(linkedPrototypeScene(doc));
  const candidates = new Set(
    selection
      .filter((id) => doc.nodes.some((n) => n.id === id))
      .map((id) => ancestors(doc, id).at(-1)?.id ?? id),
  );
  const roots = doc.nodes.filter((n) => n.parentId === null);
  const program = prototypeProgram(doc);
  if (program) {
    const page = structuredClone(currentPageOnly(doc));
    const start =
      candidates.size === 1 ? [...candidates][0] : program.flows[0]?.id;
    if (start) {
      const first = page.nodes.find((n) => n.id === start)!;
      first.interaction = {
        ...first.interaction,
        flow: first.interaction?.flow ?? first.name,
      };
      page.nodes = [first, ...page.nodes.filter((n) => n !== first)];
    }
    return page;
  }
  const rootId =
    candidates.size === 1
      ? [...candidates][0]
      : roots.length === 1
        ? roots[0].id
        : null;
  if (!rootId) throw new Error("请选择一个画板，或从文件菜单导出整个文件");
  const included = subtreeIds(doc, [rootId]);
  const output = structuredClone(currentPageOnly(doc));
  output.nodes = output.nodes.filter((n) => included.has(n.id));
  const root = output.nodes.find((n) => n.id === rootId)!;
  root.style.x = 0;
  root.style.y = 0;
  root.parentId = null;
  return output;
}
export function runtimeNodes(
  doc: DesignDocument,
  rootIds?: string[],
  symbolic = false,
): RuntimeNode[] {
  const effectiveRootIds = rootIds
    ? (() => {
        const byId = new Map(doc.nodes.map((n) => [n.id, n]));
        const out: string[] = [];
        const expand = (id: string) => {
          const node = byId.get(id);
          if (!node || node.type === "slice") return;
          if (node.type === "section") {
            for (const child of doc.nodes)
              if (child.parentId === id) expand(child.id);
          } else {
            out.push(id);
          }
        };
        for (const id of rootIds) expand(id);
        return out;
      })()
    : undefined;
  doc = resolvedDocument(unwrapSectionsAndSlices(doc));
  indexPublishedScene(doc);
  const measured = new Map(sizeScene(doc).nodes.map((n) => [n.id, n.style]));
  const children = new Map<string | null, DesignNode[]>();
  for (const n of doc.nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const build = (raw: DesignNode): RuntimeNode => {
    const node = displayNode(
      symbolPaintForView(raw, "export"),
      doc.colorProfile,
    );
    const burn = linearBurnLayer(node, doc);
    const glyphs = currentTextShape(node);
    const layout = currentTextLayout(node);
    let blendedPaints: RuntimeNode["blendedPaints"];
    const style = {
      margin: 0,
      ...(symbolic
        ? {
            ...symbolicNodeCss(doc, node, nodeCss(raw, doc), (layers) => {
              blendedPaints = layers;
            }),
            ...scopedCssVariables(doc, node),
          }
        : nodeCss(raw, doc)),
      ...(!node.parentId && node.style.viewportWidth ? { width: "100%" } : {}),
    } as RuntimeNode["style"];
    exposeSurface(node, style);
    const glass = sampleGlass(node, doc, style);
    const boxPaint = !burn ? blendedStrokePaint(node, doc) : undefined;
    const capsule =
      !burn && !boxPaint ? separateCapsuleFill(node, style) : undefined;
    return {
      blendedPaints,
      id: node.id,
      name: node.name,
      ...(node.siblingMask && node.parentId
        ? {
            siblingMask: siblingMaskPaint(
              doc,
              findLayer(doc, node.parentId)!,
              raw,
              symbolic,
            ),
          }
        : {}),
      key: node.templateKey,
      ...(node.hidden && node.templateKey
        ? {
            visibleDisplay: nodeCss({ ...node, hidden: false }, doc)
              .display as RuntimeNode["visibleDisplay"],
          }
        : {}),
      component: (() => {
        const c = layerComponent(doc, node);
        return c ? JSON.stringify([c.libraryId, c.componentId]) : undefined;
      })(),
      text: node.text,
      glass,
      boxBurn: burn,
      capsule,
      boxPaint,
      strokePaints: strokePaintLayers(
        node,
        symbolic && doc.designSystem
          ? (id) => cssVariableName(doc.designSystem!, id)
          : undefined,
      ),
      boxShadows: independentShadows(node),
      inkPaints: textInkPaints(node),
      inkShadows:
        node.type === "text" &&
        node.style.textEffectClip === "glyphs" &&
        !node.style.tint
          ? node.style.shadows
              ?.filter((s) => s.visible !== false)
              .map(
                ({ x, y, blur, spread, inset, color, opacity, blendMode }) => ({
                  x,
                  y,
                  blur,
                  spread,
                  inset,
                  color,
                  opacity,
                  blendMode,
                }),
              )
          : undefined,
      sourceTextLayout: layout && {
        text: layout.text,
        width: layout.width,
        height: layout.height,
        lines: layout.lines,
      },
      sourceTextShape: glyphs && {
        text: glyphs.text,
        ...(glyphs.coverageOffsets
          ? { coverageOffsets: glyphs.coverageOffsets }
          : {}),
        d: glyphs.d,
        width: glyphs.width,
        height: glyphs.height,
      },
      parts: node.textRuns?.length ? textParts(node) : undefined,
      type: node.type,
      style,
      ...(node.control || (!node.parentId && node.type === "frame")
        ? {
            geometry: {
              width: measured.get(node.id)!.width,
              height: measured.get(node.id)!.height,
            },
          }
        : {}),
      control: node.control,
      gridBreakpoint: gridBreakpoint(node),
      ...(node.variableBindings?.visible || node.variableBindings?.text
        ? {
            bindings: {
              text: node.variableBindings.text,
              visible: node.variableBindings.visible,
              display:
                node.type === "button" ||
                (node.type === "frame" && node.style.layout !== "free")
                  ? "flex"
                  : "block",
            },
          }
        : {}),
      vector: node.booleanOperation
        ? (booleanVector(doc, node) ?? undefined)
        : node.vector,
      image: node.image && {
        ...imagePaint(node.image, doc.images?.[node.image.assetId]),
        ...(!symbolic
          ? { source: doc.images?.[node.image.assetId]?.data }
          : {}),
      },
      children: node.booleanOperation
        ? []
        : (children.get(node.id) ?? [])
            .filter((n) => n.id !== node.maskSourceId)
            .map(build),
    };
  };
  return (
    effectiveRootIds
      ? doc.nodes.filter((n) => effectiveRootIds.includes(n.id))
      : (children.get(null) ?? [])
  ).map(build);
}
export function documentRuntimeStyle(
  doc: DesignDocument,
  inlineVariables = false,
): CSSProperties {
  doc = sizeScene(resolvedDocument(unwrapSectionsAndSlices(doc)));
  return {
    ...(doc.designSystem && inlineVariables
      ? Object.fromEntries(
          Object.keys(doc.designSystem.variables).map((id) => [
            cssVariableName(doc.designSystem!, id),
            cssTokenValue(
              doc.designSystem!,
              id,
              doc.designSystem!.activeModes,
              doc.colorProfile,
            ),
          ]),
        )
      : {}),
    ...Object.fromEntries(
      Object.entries(doc.tokens).map(([id, t]) => [
        `--token-${id}`,
        displayColor(t.value, doc.colorProfile),
      ]),
    ),
    position: "relative",
    minWidth: Math.max(
      390,
      ...doc.nodes
        .filter((n) => !n.parentId)
        .map((n) => n.style.x + n.style.width),
    ),
    minHeight: Math.max(
      800,
      ...doc.nodes
        .filter((n) => !n.parentId)
        .map((n) => n.style.y + n.style.height),
    ),
    fontFamily: "system-ui, sans-serif",
    ...(doc.nodes.some((n) => !n.parentId && n.style.viewportWidth)
      ? { width: "100%", minWidth: 0 }
      : {}),
  };
}
export function exportInteractiveReact(
  doc: DesignDocument,
  allScreens = false,
  useComponents = false,
  pageData?: { module: string; files: Record<string, string> },
): string {
  const components = useComponents ? pageComponentImports(doc) : [];
  const program = prototypeProgram(doc);
  const hasImages = Object.keys(doc.images ?? {}).length > 0;
  const imports = [
    'import type { CSSProperties } from "react";',
    'import { DesignNodeView, type RuntimeNode, type DesignAction } from "./FormaRuntime";',
    ...(program
      ? [
          'import { PrototypePlayer } from "./PrototypePlayer";',
          'import type { Program } from "./prototype-machine";',
        ]
      : []),
    ...(hasImages
      ? [
          'import { ImageResources } from "./FormaRuntime";',
          'import images from "./design-images";',
        ]
      : []),
  ];
  if (components.length) {
    imports.push(
      'import { DesignComponents } from "./FormaRuntime";',
      ...components.map(
        (c) => "import " + c.local + ' from "./components/' + c.path + '";',
      ),
    );
  }
  const tree = runtimeNodes(doc, undefined, true);
  let nodeSource: string;
  if (pageData && doc.nodes.length > 128) {
    const resource = pageData.module + ".nodes.json";
    pageData.files["src/" + resource] = JSON.stringify(tree);
    imports.push(
      "import serializedNodes from " +
        JSON.stringify("./" + resource + "?raw") +
        ";",
    );
    nodeSource = "JSON.parse(serializedNodes)";
  } else {
    nodeSource = JSON.stringify(tree, null, 2);
  }
  const definitions = [
    ...(components.length
      ? [
          "const components = {" +
            components
              .map((c) => JSON.stringify(c.key) + ": " + c.local)
              .join(", ") +
            "};",
        ]
      : []),
    "const nodes: RuntimeNode[] = " + nodeSource + ";",
    "const pageStyle = " +
      JSON.stringify(documentRuntimeStyle(doc)) +
      " as CSSProperties;",
  ];
  if (program)
    definitions.push(
      "const program: Program = " + JSON.stringify(program, null, 2) + ";",
      "export const flows = program.flows;",
    );
  const playerStart = allScreens
    ? "nodes.some(n => n.id === flow) ? flow : flows[0].id"
    : "flows.some(f => f.id === flow) ? flow : flows[0].id";
  const content = program
    ? "<PrototypePlayer key={flow} nodes={nodes} program={program} start={" +
      playerStart +
      "} onAction={onAction} style={pageStyle}/>"
    : allScreens
      ? "<main style={{...pageStyle, minWidth: 0, minHeight: 0}}>{screen && <DesignNodeView node={{...screen, style:{...screen.style, position:'relative', left:0, top:0}}} onAction={onAction}/>}</main>"
      : "<main style={pageStyle}>{nodes.map(node => <DesignNodeView key={node.id} node={node} onAction={onAction}/>)}</main>";
  const view = components.length
    ? "<DesignComponents.Provider value={components}>" +
      content +
      "</DesignComponents.Provider>"
    : content;
  const props = program
    ? "{ flow = flows[0].id, onAction }: { flow?: string; onAction?: DesignAction }"
    : allScreens
      ? "{ flow, onAction }: { flow?: string; onAction?: DesignAction }"
      : "{ onAction }: { onAction?: DesignAction }";
  return [
    ...imports,
    "",
    ...definitions,
    "",
    "export default function DesignPage(" + props + ") {",
    ...(!program && allScreens
      ? ["  const screen = nodes.find(n => n.id === flow) ?? nodes[0];"]
      : []),
    "  return " +
      (hasImages
        ? "<ImageResources.Provider value={images}>" +
          view +
          "</ImageResources.Provider>"
        : view) +
      ";",
    "}",
    "",
  ].join("\n");
}
export function reactProjectFiles(
  doc: DesignDocument,
  runtimeSource: string,
  playerSources?: Record<string, string>,
  includeDesign = true,
): Record<string, string> {
  if (prototypeProgram(doc) && !playerSources)
    throw new Error("缺少原型运行时源文件");
  const files = reactProjectBase(doc, runtimeSource, includeDesign);
  const page = exportInteractiveReact(doc, false, true, {
    module: "DesignPage",
    files,
  });
  return {
    ...files,
    "src/DesignPage.tsx": page,
    ...(prototypeProgram(doc) ? playerSources : {}),
  };
}

export function imageFilename(id: string, data: string) {
  return (
    id +
    "." +
    data.slice("data:image/".length, data.indexOf(";")).replace("jpeg", "jpg")
  );
}

export function reactProjectBase(
  doc: DesignDocument,
  runtimeSource: string,
  includeDesign = true,
): Record<string, string> {
  const tokens = exportTokenFiles(doc);
  const faces = Object.entries(doc.fonts ?? {}).map(([id, f]) => {
    const ext = f.data.startsWith("data:font/otf") ? "otf" : "ttf",
      weight = fontFaceWeight(f);
    return (
      '@font-face { font-family: "' +
      id +
      '"; src: url("./assets/' +
      id +
      "." +
      ext +
      '");' +
      (weight ? " font-weight: " + weight + ";" : "") +
      (f.italic ? " font-style: italic;" : "") +
      " }"
    );
  });
  return {
    "package.json": JSON.stringify(
      {
        name: "forma-design-export",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "tsc --noEmit && vite build",
        },
        dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
        devDependencies: {
          "@types/react": "^19.2.0",
          "@types/react-dom": "^19.2.0",
          typescript: "^5.9.0",
          vite: "^7.2.0",
        },
      },
      null,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          types: ["vite/client"],
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
    "index.html":
      '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Forma Design</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    "src/main.tsx":
      "import './tokens.css';\n" +
      "import { createRoot } from 'react-dom/client';\nimport DesignPage from './DesignPage';\nimport { onDesignAction } from './business';\ncreateRoot(document.getElementById('root')!).render(<DesignPage onAction={onDesignAction}/>);\n",
    "src/business.ts":
      "import type { DesignAction } from './FormaRuntime';\n\n/** Connect design node IDs to your application here. */\nexport const onDesignAction: DesignAction = (_id, _value) => {};\n",
    "src/FormaRuntime.tsx": runtimeSource,
    ...(Object.keys(doc.images ?? {}).length
      ? {
          "src/design-images.ts":
            "export default {\n" +
            Object.entries(doc.images!)
              .map(
                ([id, img]) =>
                  "  " +
                  JSON.stringify(id) +
                  ": { data: new URL(" +
                  JSON.stringify("./assets/" + imageFilename(id, img.data)) +
                  ", import.meta.url).href },",
              )
              .join("\n") +
            "\n};\n",
        }
      : {}),
    ...componentProjectFiles(doc, (page) =>
      runtimeNodes(page, undefined, true),
    ),
    ...tokens,
    "src/tokens.css": [...faces, tokens["src/tokens.css"] ?? ""].join("\n"),
    ...(includeDesign ? { "design.forma.json": nativeDocumentText(doc) } : {}),
    "README.md":
      "# Forma React export\n\nRun `npm install` then `npm run dev`. Verify with `npm run build`.\n\nReusable component modules live in src/components for the components used in your file. Import a module and pass instanceId, variant, and optional text overrides keyed by template key. The generated pages use the same modules with their exact instance overrides.\n\nPlace your business handlers in src/business.ts. To update a design, ZIP the project source with forma-project.json (exclude dependencies, dist and .git). In Forma choose 文件菜单 → 更新已有 React 工程 and select that ZIP. The new archive preserves your entry point, configuration and custom files. A conflict in generated code blocks the merge and names the file.\n\nDesignPage accepts an optional `onAction(id, value)` callback for business integration. Native inputs, switches, checkboxes, sliders, steppers, segmented controls and progress semantics are implemented. Declared prototype flows include navigation, overlays, history, scrolling, conditions, variables and ordered actions. Wire business services and system sharing through the application.\n\nThe exporter writes fixed, intrinsic and fill sizes, text runs, horizontal wrapping, responsive grids, free-frame constraints, image crops and vector paths. Fixed-column grids can change column count and spacing at their configured container width. The project includes resources embedded in the source document and uses system fallbacks for unavailable fonts. The serialized design is included for reopening in Forma. Design-system exports include collections, modes, aliases, style definitions and bindings in design-system.json and design.forma.json, plus CSS and TypeScript tokens. Supported paint, numeric and typography bindings use CSS variables. String content, boolean visibility and native control geometry are resolved for the exported modes; those changes require re-export. Element mode overrides are emitted as scoped CSS custom properties.\n",
  };
}
