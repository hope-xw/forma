import { iconToFormaVector } from "../agent/icon-library";
import { transact, type Operation } from "../domain/commands";
import { remapDesignBindings } from "../domain/design-system";
import {
  emptyDesignSystem,
  type DesignSystem,
} from "../domain/design-system-schema";
import {
  defaultStyle,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../domain/document";
import type { Point } from "../domain/geometry";
import { installLibrary, instantiateComponent } from "../domain/library";
import {
  integrateLibrarySystem,
  templateNodes,
} from "../domain/library-design-system";
import type {
  ComponentLibrary,
  LibraryComponent,
} from "../domain/library-schema";

export type Appearance = "Light" | "Dark";
export type VariantProps = Record<string, string>;
export type LibraryPlatform =
  "ios" | "android" | "web-enterprise" | "web-modern";
export type KitTypographySpec = {
  readonly name: string;
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: number;
};
export type KitScaleSpec = {
  readonly name: string;
  readonly value: string;
  readonly kind: "radius" | "spacing";
};
export type KitTemplateMeta = {
  readonly id: string;
  readonly libraryId: string;
  readonly name: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly platform: LibraryPlatform;
};

type Axes = Record<string, readonly string[]>;
type Palette = Record<string, string>;
export function combinations(axes: Axes = {}): VariantProps[] {
  return Object.entries(axes).reduce<VariantProps[]>(
    (sets, [axis, values]) =>
      sets.flatMap((set) => values.map((value) => ({ ...set, [axis]: value }))),
    [{}],
  );
}

export function createAppearanceSystem(
  collectionId: string,
  collectionName: string,
  namePrefix: string,
  idPrefix: string,
  light: Palette,
  dark: Palette,
): DesignSystem {
  const system = emptyDesignSystem();
  system.collections[collectionId] = {
    id: collectionId,
    name: collectionName,
    defaultModeId: "light",
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  };
  for (const [role, value] of Object.entries(light)) {
    const id = idPrefix + "-" + role;
    system.variables[id] = {
      id,
      name: namePrefix + "/" + role,
      collectionId,
      type: "color",
      description: "",
      codeSyntax: "--" + id,
      scopes: ["fill", "color", "stroke"],
      values: { light: value, dark: dark[role] },
    };
  }
  return system;
}

const paintKeys = ["color", "fill", "stroke"] as const;
function usesPaint(node: DesignNode, property: (typeof paintKeys)[number]) {
  if (property === "color")
    return ["text", "vector", "button"].includes(node.type);
  if (property === "stroke") return (node.style.strokeWidth ?? 0) > 0;
  return (
    !["text", "vector", "group"].includes(node.type) &&
    node.style.fillOpacity !== 0
  );
}
export function bindPaletteVariant(
  nodes: DesignNode[],
  collectionId: string,
  idPrefix: string,
  palette: Palette,
  appearance: Appearance,
  skipRolesForColor: readonly string[] = [
    "background",
    "card",
    "canvas",
    "surface",
    "surfaceContainer",
    "surfaceContainerHigh",
    "primaryContainer",
    "secondaryContainer",
    "muted",
  ],
  surfaceOnlyFrameRoles: readonly string[] = [],
) {
  const entries = Object.entries(palette);
  for (const node of nodes) {
    if (node.parentId === null)
      (node.variableModes ??= {})[collectionId] = appearance.toLowerCase();
    for (const property of paintKeys) {
      if (
        !usesPaint(node, property) ||
        node.variableBindings?.[property] ||
        node.styleBindings?.[property === "stroke" ? "stroke" : "paint"]
      )
        continue;
      const hex = node.style[property]?.toLowerCase();
      const match = entries.find(
        ([role, value]) =>
          value.toLowerCase() === hex &&
          (property !== "color" || !skipRolesForColor.includes(role)) &&
          (node.type === "frame" || !surfaceOnlyFrameRoles.includes(role)),
      );
      if (match)
        (node.variableBindings ??= {})[property] = idPrefix + "-" + match[0];
    }
  }
}

type KitDefaults = {
  fill: string;
  text: string;
  accent: string;
  secondary: string;
  surface: string;
  border: string;
  fontFamily: string;
  radius?: number;
  semantic?: { palette: Palette; idPrefix: string };
};

export class KitBuilder {
  readonly nodes: DesignNode[] = [];
  constructor(
    readonly appearance: Appearance,
    readonly name: string,
    width: number,
    height: number,
    readonly defaults: KitDefaults,
  ) {
    this.add(
      "frame",
      "root",
      null,
      { width, height, fill: defaults.fill, radius: defaults.radius ?? 0 },
      name,
    );
  }
  get root() {
    return this.nodes[0];
  }

  // Named paints preserve intent even when two semantic roles share the same hex.
  private applyStyle(node: DesignNode, style: Partial<NodeStyle>) {
    Object.assign(node.style, style);
    for (const property of paintKeys) {
      const role = style[property];
      if (role === undefined) continue;
      const semantic = this.defaults.semantic;
      if (node.variableBindings) delete node.variableBindings[property];
      if (semantic && Object.hasOwn(semantic.palette, role)) {
        node.style[property] = semantic.palette[role];
        if (usesPaint(node, property))
          (node.variableBindings ??= {})[property] =
            semantic.idPrefix + "-" + role;
      }
    }
  }
  rootStyle(style: Partial<NodeStyle>) {
    this.applyStyle(this.root, style);
  }
  add(
    type: DesignNode["type"],
    key: string,
    parentId: string | null,
    style: Partial<NodeStyle>,
    name = key,
    text = "",
  ) {
    if (!key || this.nodes.some((node) => node.id === key))
      throw Error("模板键为空或重复：" + key);
    if (
      parentId === null
        ? this.nodes.length > 0
        : !this.nodes.some(
            (n) => n.id === parentId && ["frame", "group"].includes(n.type),
          )
    )
      throw Error("组件父图层无效：" + parentId);
    const node: DesignNode = {
      id: key,
      templateKey: key,
      type,
      parentId,
      name,
      text,
      hidden: false,
      locked: false,
      style: {
        ...defaultStyle,
        padding: 0,
        gap: 0,
        radius: 0,
        fontSize: 14,
        fontFamily: this.defaults.fontFamily,
        fill: this.defaults.surface,
        color: this.defaults.text,
      },
    };
    this.applyStyle(node, style);
    this.nodes.push(node);
    return node;
  }
  box(
    key: string,
    x: number,
    y: number,
    width: number,
    height: number,
    style: Partial<NodeStyle> = {},
    parent = "root",
  ) {
    return this.add("rectangle", key, parent, {
      x,
      y,
      width,
      height,
      ...style,
    });
  }
  frame(
    key: string,
    x: number,
    y: number,
    width: number,
    height: number,
    style: Omit<Partial<NodeStyle>, "layout"> & {
      layout?: NodeStyle["layout"] | "horizontal" | "vertical";
    } = {},
    parent = "root",
    name = key,
  ) {
    const { layout, ...properties } = style;
    const direction =
      layout === "horizontal"
        ? "row"
        : layout === "vertical"
          ? "column"
          : layout;
    return this.add(
      "frame",
      key,
      parent,
      {
        x,
        y,
        width,
        height,
        ...properties,
        ...(direction ? { layout: direction } : {}),
      },
      name,
    );
  }
  pill(
    key: string,
    x: number,
    y: number,
    width: number,
    height: number,
    style: Partial<NodeStyle> = {},
    parent = "root",
  ) {
    return this.box(
      key,
      x,
      y,
      width,
      height,
      { radius: height / 2, ...style },
      parent,
    );
  }
  text(
    key: string,
    text: string,
    x: number,
    y: number,
    width: number,
    size = 14,
    style: Partial<NodeStyle> = {},
    parent = "root",
  ) {
    const lineHeight = style.lineHeight ?? Math.round(size * 1.4);
    return this.add(
      "text",
      key,
      parent,
      { x, y, width, height: lineHeight, fontSize: size, lineHeight, ...style },
      text.slice(0, 80) || key,
      text,
    );
  }
  lucideIcon(
    key: string,
    iconName: string,
    x: number,
    y: number,
    size = 24,
    color = this.defaults.text,
    strokeWidth = 1.75,
    parent = "root",
  ) {
    const node = this.add(
      "vector",
      key,
      parent,
      { x, y, width: size, height: size, color },
      iconName,
    );
    const vector = iconToFormaVector(iconName, {
      color: node.style.color,
      strokeWidth,
    });
    const paths = vector?.paths.filter(
      (path) => typeof path.d === "string" && path.d.length > 0,
    );
    // Inherit the layer color, so a mode change recolors every Lucide stroke.
    node.vector = {
      width: 24,
      height: 24,
      paths: paths?.length
        ? paths.map(
            ({ strokeColor: _stroke, fillColor: _fill, ...path }) => path,
          )
        : [
            {
              d: "M12 3 L21 12 L12 21 L3 12 Z",
              fill: false,
              strokeWidth: Math.max(
                0,
                Math.min(
                  100,
                  Number.isFinite(strokeWidth) ? strokeWidth : 1.75,
                ),
              ),
              lineJoin: "round",
            },
          ],
    };
    return node;
  }
  divider(
    key: string,
    x: number,
    y: number,
    width: number,
    color: string,
    parent = "root",
  ) {
    return this.box(key, x, y, width, 1, { fill: color }, parent);
  }
  control(
    kind: NonNullable<DesignNode["control"]>["kind"] | "input",
    value: boolean | number | string,
    disabled = false,
    options?: readonly string[],
  ) {
    const { accent, secondary: track, surface, border } = this.defaults;
    this.root.control = {
      kind: kind === "input" ? "textfield" : kind,
      label: this.name,
      value,
      disabled,
      palette: { accent, track, surface, border },
      ...(options ? { options: [...options] } : {}),
    };
  }
}

export function kitTokens(
  themes: Record<Appearance, Palette>,
  idPrefix: string,
  namePrefix: string,
): Record<string, { name: string; value: string }> {
  return Object.fromEntries(
    Object.entries(themes).flatMap(([mode, palette]) =>
      Object.entries(palette).map(([role, value]) => [
        [idPrefix, mode.toLowerCase(), role].join("-"),
        { name: [namePrefix, mode, role].join("/"), value },
      ]),
    ),
  );
}

export type KitDefinition = {
  id: string;
  name: string;
  category: string;
  description: string;
  width: number;
  height: number;
  axes: Axes;
  draw(builder: KitBuilder, props: VariantProps): void;
};

export function kitComponents(
  definitions: KitDefinition[],
  themes: Record<Appearance, Palette>,
  collectionId: string,
  idPrefix: string,
  defaults: (a: Appearance) => KitDefaults,
): LibraryComponent[] {
  return definitions.map(
    ({ id, name, category, description, width, height, axes, draw }) => ({
      id,
      name,
      category,
      description,
      variants: (["Light", "Dark"] as const).flatMap((appearance) =>
        combinations(axes).map((props) => {
          const builder = new KitBuilder(
            appearance,
            name,
            width,
            height,
            defaults(appearance),
          );
          draw(builder, props);
          bindPaletteVariant(
            builder.nodes,
            collectionId,
            idPrefix,
            themes[appearance],
            appearance,
          );
          const properties = { Appearance: appearance, ...props };
          return {
            id: Object.values(properties).join("-"),
            name: Object.values(properties).join(" / "),
            properties,
            nodes: builder.nodes,
          };
        }),
      ),
    }),
  );
}

export type KitPlacement = {
  component: string;
  x: number;
  y: number;
  props?: VariantProps;
  text?: Record<string, string>;
  inputValue?: string;
};

/** A previous import may have renamed both the library and its variables to
 * avoid file-local collisions. Compare its component definitions in that same
 * namespace before asking installLibrary to allocate another snapshot. */
function templateLibrary(doc: DesignDocument, library: ComponentLibrary) {
  const [sourceCollection] = Object.values(library.designSystem!.collections);
  for (const existing of Object.values(doc.libraries ?? {})) {
    const system = existing.designSystem;
    if (
      !system ||
      existing.revision !== library.revision ||
      existing.source.name !== library.source.name ||
      (existing.id !== library.id &&
        !existing.id.startsWith(library.id + "-")) ||
      (existing.id === library.id && system.collections[sourceCollection.id])
    )
      continue;
    const collection = Object.values(system.collections).find(
      (c) => c.name === sourceCollection.name,
    );
    if (!collection) continue;
    const maps = {
      collections: new Map([[sourceCollection.id, collection.id]]),
      variables: new Map(
        Object.values(system.variables).map((v) => [
          v.codeSyntax.slice(2),
          v.id,
        ]),
      ),
      styles: new Map<string, string>(),
    };
    const copy = structuredClone(library);
    for (const node of templateNodes(copy)) remapDesignBindings(node, maps);
    if (JSON.stringify(copy.components) === JSON.stringify(existing.components))
      return existing;
  }
  return installLibrary(doc, library);
}

/** Every placement is a sibling on a free-layout board. Only the board and library
 * must exist while planning their independent insertions in one transaction. */
export function assembleKitTemplate(
  doc: DesignDocument,
  library: ComponentLibrary,
  board: KitBuilder,
  origin: Point,
  placements: KitPlacement[],
): { operations: Operation[]; id: string } {
  const { library: installed, system } = integrateLibrarySystem(
    doc,
    templateLibrary(doc, library),
  );
  const operations: Operation[] = [];
  if (system && system !== doc.designSystem)
    operations.push({ type: "setDesignSystem", system });
  if (
    JSON.stringify(doc.libraries?.[installed.id]) !== JSON.stringify(installed)
  )
    operations.push({ type: "putLibrary", library: installed });
  const variables = new Map(
    Object.values(installed.designSystem!.variables).map((v) => [
      v.codeSyntax,
      v,
    ]),
  );
  const ids = new Map(board.nodes.map((n) => [n.id, crypto.randomUUID()]));
  for (const source of board.nodes) {
    const node = structuredClone(source);
    delete node.templateKey;
    node.id = ids.get(source.id)!;
    node.parentId = source.parentId === null ? null : ids.get(source.parentId)!;
    for (const property of paintKeys) {
      const variable = node.variableBindings?.[property];
      if (variable)
        node.variableBindings![property] = variables.get("--" + variable)!.id;
    }
    if (!node.parentId) {
      Object.assign(node.style, origin);
      const collectionId = Object.values(installed.designSystem!.collections)[0]
        .id;
      node.variableModes = { [collectionId]: board.appearance.toLowerCase() };
    }
    operations.push({ type: "create", node });
  }
  const workspace = transact(doc, { baseRevision: doc.revision, operations });
  const id = ids.get("root")!;
  for (const placement of placements) {
    const component = installed.components.find(
      (c) => c.id === placement.component,
    );
    const variant = component?.variants.find(
      (v) =>
        v.properties.Appearance === board.appearance &&
        Object.entries(placement.props ?? {}).every(
          ([axis, value]) => v.properties[axis] === value,
        ),
    );
    if (!component || !variant)
      throw Error("找不到模板组件变体：" + placement.component);
    const insertion = instantiateComponent(
      workspace,
      installed,
      component.id,
      variant.id,
      id,
      { x: origin.x + placement.x, y: origin.y + placement.y },
    );
    operations.push(...insertion.operations);
    if (placement.inputValue !== undefined) {
      const root = insertion.operations.find(
        (op) => op.type === "create" && op.node.id === insertion.id,
      );
      if (root?.type !== "create" || root.node.control?.kind !== "textfield")
        throw Error("模板控件类型不支持输入值：" + placement.component);
      operations.push({
        type: "update",
        id: insertion.id,
        patch: {
          control: { ...root.node.control, value: placement.inputValue },
        },
      });
    }
    const textOverrides =
      placement.inputValue === undefined
        ? placement.text
        : { ...placement.text, value: placement.inputValue };
    for (const [key, text] of Object.entries(textOverrides ?? {})) {
      const child = insertion.operations.find(
        (op) => op.type === "create" && op.node.templateKey === key,
      );
      if (
        child?.type !== "create" ||
        !["text", "button"].includes(child.node.type)
      )
        throw Error("找不到模板文字：" + key);
      operations.push({ type: "update", id: child.node.id, patch: { text } });
    }
  }
  return { operations, id };
}
