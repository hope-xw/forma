import {
  defaultStyle,
  type DesignNode,
  type NodeStyle,
} from "../domain/document";
export type Appearance = "Light" | "Dark";
export const mobileThemes = {
  Light: {
    canvas: "#f3f5f9",
    surface: "#ffffff",
    secondary: "#e9edf4",
    text: "#192234",
    muted: "#778195",
    border: "#dce2ec",
    accent: "#246bfd",
    tint: "#e6eeff",
    danger: "#df354d",
    success: "#25a975",
  },
  Dark: {
    canvas: "#11151d",
    surface: "#202734",
    secondary: "#303a4c",
    text: "#f5f7fc",
    muted: "#a0acc0",
    border: "#394459",
    accent: "#77a3ff",
    tint: "#253d66",
    danger: "#ff7588",
    success: "#52d6a2",
  },
} as const;
export type MobileTheme = (typeof mobileThemes)[Appearance];
export const mobileTypography = [
  { name: "Display", size: 34, lineHeight: 41, weight: 700 },
  { name: "Title", size: 28, lineHeight: 35, weight: 700 },
  { name: "Heading", size: 22, lineHeight: 28, weight: 600 },
  { name: "Body", size: 17, lineHeight: 24, weight: 400 },
  { name: "Label", size: 15, lineHeight: 20, weight: 600 },
  { name: "Footnote", size: 13, lineHeight: 18, weight: 400 },
  { name: "Caption", size: 11, lineHeight: 16, weight: 500 },
] as const;
export const mobileIcons = {
  play: "M7 3 L21 12 L7 21 Z",
  pause: "M8 4 V20 M16 4 V20",
  previous: "M5 4 V20 M20 4 L7 12 L20 20 Z",
  next: "M19 4 V20 M4 4 L17 12 L4 20 Z",
  radio:
    "M5 6 C-1 12 5 18 5 18 M19 6 C25 12 19 18 19 18 M8 9 C5 12 8 15 8 15 M16 9 C19 12 16 15 16 15 M12 11 V13",
  clock: "M21 12 A9 9 0 1 1 3 12 A9 9 0 1 1 21 12 M12 6 V12 L16 15",
  download: "M12 3 V16 M7 11 L12 16 L17 11 M4 17 V21 H20 V17",
  headphones:
    "M3 14 V11 A9 9 0 0 1 21 11 V14 M3 12 H7 V21 H3 Z M17 12 H21 V21 H17 Z",
  sparkles:
    "M12 2 L15 9 L22 12 L15 15 L12 22 L9 15 L2 12 L9 9 Z M20 2 V6 M18 4 H22",
  shuffle:
    "M3 6 H7 L17 18 H21 M17 14 L21 18 L17 22 M3 18 H7 L17 6 H21 M17 2 L21 6 L17 10",
  repeat: "M3 8 V5 H20 M17 2 L20 5 L17 8 M21 16 V19 H4 M7 16 L4 19 L7 22",
  monitor: "M2 3 H22 V17 H2 Z M12 17 V21 M7 21 H17",
  volume:
    "M3 9 H7 L12 4 V20 L7 15 H3 Z M16 8 C20 12 16 16 16 16 M19 4 C25 12 19 20 19 20",
  list: "M8 5 H21 M8 12 H21 M8 19 H21 M3 5 H4 M3 12 H4 M3 19 H4",
  expand: "M8 3 H3 V8 M16 3 H21 V8 M21 16 V21 H16 M3 16 V21 H8",

  back: "M15 5 L8 12 L15 19",
  forward: "M9 5 L16 12 L9 19",
  close: "M6 6 L18 18 M18 6 L6 18",
  plus: "M12 5 V19 M5 12 H19",
  minus: "M5 12 H19",
  check: "M5 12 L10 17 L20 6",
  search: "M16 16 L21 21 M18 10 A8 8 0 1 1 2 10 A8 8 0 1 1 18 10",
  home: "M3 11 L12 3 L21 11 M5 9 V21 H10 V15 H14 V21 H19 V9",
  grid: "M3 3 H9 V9 H3 Z M15 3 H21 V9 H15 Z M3 15 H9 V21 H3 Z M15 15 H21 V21 H15 Z",
  person:
    "M16 7 A4 4 0 1 1 8 7 A4 4 0 1 1 16 7 M4 21 V19 C4 12 20 12 20 19 V21",
  bell: "M5 17 H19 L17 14 V9 C17 2 7 2 7 9 V14 Z M10 21 H14",
  mail: "M3 5 H21 V19 H3 Z M3 5 L12 13 L21 5",
  heart: "M12 21 L3 12 C-3 3 8 0 12 7 C16 0 27 3 21 12 Z",
  share: "M12 15 V2 M7 7 L12 2 L17 7 M5 11 V21 H19 V11",
  folder: "M3 7 V4 H10 L13 7 H21 V21 H3 Z",
  settings: "M4 6 H20 M4 12 H20 M4 18 H20 M8 3 V9 M16 9 V15 M10 15 V21",
  calendar: "M3 5 H21 V21 H3 Z M7 2 V8 M17 2 V8 M3 10 H21",
  cloud: "M5 19 C-2 18 0 9 6 10 C6 0 20 1 19 11 C26 12 23 20 18 19 Z",
  sun: "M16 12 A4 4 0 1 1 8 12 A4 4 0 1 1 16 12 M12 1 V4 M12 20 V23 M1 12 H4 M20 12 H23 M4 4 L6 6 M18 18 L20 20 M20 4 L18 6 M6 18 L4 20",
  shield:
    "M12 2 L21 6 V12 C21 18 12 22 12 22 C12 22 3 18 3 12 V6 Z M7 12 L11 16 L17 9",
  more: "M4 12 H5 M11 12 H12 M18 12 H19",
} as const;

/** Original vector paths and geometry; no SF Symbols, Apple images or bundled fonts. */
export class MobileBuilder {
  readonly nodes: DesignNode[] = [];
  readonly theme: MobileTheme;
  constructor(
    readonly appearance: Appearance,
    readonly name: string,
    width: number,
    height: number,
  ) {
    this.theme = mobileThemes[appearance];
    this.add(
      "frame",
      "root",
      null,
      { width, height, fill: this.theme.surface, radius: 18, padding: 0 },
      name,
    );
  }
  get root() {
    return this.nodes[0];
  }
  add(
    type: DesignNode["type"],
    key: string,
    parentId: string | null,
    style: Partial<NodeStyle>,
    name = key,
    text = "",
  ) {
    const node: DesignNode = {
      id: key,
      templateKey: key,
      parentId,
      type,
      name,
      text,
      hidden: false,
      locked: false,
      style: {
        ...defaultStyle,
        padding: 0,
        radius: 0,
        fontSize: 17,
        fontFamily: "system-ui, sans-serif",
        lineHeight: 24,
        color: this.theme.text,
        fill: this.theme.surface,
        ...style,
      },
    };
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
  text(
    key: string,
    text: string,
    x: number,
    y: number,
    width: number,
    size = 17,
    style: Partial<NodeStyle> = {},
    parent = "root",
  ) {
    return this.add(
      "text",
      key,
      parent,
      {
        x,
        y,
        width,
        height: Math.ceil(size * 1.5),
        fontSize: size,
        lineHeight: Math.ceil(size * 1.5),
        ...style,
      },
      text.slice(0, 30) || key,
      text,
    );
  }
  icon(
    key: string,
    icon: keyof typeof mobileIcons,
    x: number,
    y: number,
    size = 24,
    color: string = this.theme.text,
    parent = "root",
  ) {
    const node = this.add("vector", key, parent, {
      x,
      y,
      width: size,
      height: size,
      color,
    });
    node.vector = {
      width: 24,
      height: 24,
      paths: [{ d: mobileIcons[icon], fill: false, strokeWidth: 1.8 }],
    };
    return node;
  }
  separator(y: number, inset = 16, width = this.root.style.width - inset * 2) {
    return this.box(`separator-${y}`, inset, y, width, 1, {
      fill: this.theme.border,
    });
  }
  glass() {
    Object.assign(this.root.style, {
      fillOpacity: 0.84,
      backdropBlur: 24,
      stroke: this.theme.border,
      strokeWidth: 1,
      shadows: [
        {
          x: 0,
          y: 8,
          blur: 32,
          spread: -8,
          color: "#102040",
          opacity: this.appearance === "Light" ? 0.18 : 0.4,
          inset: false,
        },
      ],
    });
  }
  control(
    kind: NonNullable<DesignNode["control"]>["kind"],
    value: boolean | number | string,
    disabled = false,
    options?: string[],
  ) {
    this.root.control = {
      kind,
      value,
      label: this.name,
      palette: {
        accent: kind === "switch" ? this.theme.success : this.theme.accent,
        track: kind === "checkbox" ? this.theme.surface : this.theme.secondary,
        surface: this.theme.surface,
        border: this.theme.border,
      },
      disabled,
      ...(options ? { options } : {}),
    };
  }
}
