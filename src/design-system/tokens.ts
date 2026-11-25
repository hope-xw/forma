import {
  emptyDesignSystem,
  type DesignSystem,
} from "../domain/design-system-schema";
import { mobileThemes } from "./mobile-foundations";
export function nativeDesignSystem(): DesignSystem {
  const system = emptyDesignSystem();
  system.collections = {
    primitives: {
      id: "primitives",
      name: "Primitives",
      defaultModeId: "base",
      modes: [{ id: "base", name: "Base" }],
    },
    semantic: {
      id: "semantic",
      name: "Semantic",
      defaultModeId: "light",
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
    },
    layout: {
      id: "layout",
      name: "Layout",
      defaultModeId: "comfortable",
      modes: [
        { id: "comfortable", name: "Comfortable" },
        { id: "compact", name: "Compact" },
      ],
    },
  };
  for (const [appearance, colors] of Object.entries(mobileThemes))
    for (const [name, value] of Object.entries(colors)) {
      const id = `palette-${appearance.toLowerCase()}-${name}`;
      system.variables[id] = {
        id,
        collectionId: "primitives",
        name: `Color/${appearance}/${name}`,
        type: "color",
        values: { base: value },
        description: "",
        codeSyntax: `--${id}`,
        scopes: [],
      };
    }
  for (const name of Object.keys(mobileThemes.Light)) {
    const id = `color-${name}`;
    system.variables[id] = {
      id,
      collectionId: "semantic",
      name: `Color/${name}`,
      type: "color",
      values: {
        light: { alias: `palette-light-${name}` },
        dark: { alias: `palette-dark-${name}` },
      },
      description: "",
      codeSyntax: `--${id}`,
      scopes: [],
    };
  }
  for (const [name, comfortable, compact] of [
    ["space-sm", 8, 4],
    ["space-md", 16, 12],
    ["space-lg", 24, 16],
    ["radius-sm", 8, 4],
    ["radius-md", 16, 12],
    ["text-body", 16, 14],
    ["text-title", 28, 24],
  ] as const) {
    system.variables[name] = {
      id: name,
      collectionId: "layout",
      name: `${name.startsWith("text") ? "Typography" : name.startsWith("space") ? "Spacing" : "Radius"}/${name}`,
      type: "number",
      values: { comfortable, compact },
      description: "",
      codeSyntax: `--${name}`,
      scopes: [],
    };
  }
  system.variables["font-family"] = {
    id: "font-family",
    collectionId: "primitives",
    name: "Typography/Family",
    type: "string",
    values: { base: "system-ui, sans-serif" },
    description: "",
    codeSyntax: "--font-family",
    scopes: ["fontFamily"],
  };
  system.variables["content-label"] = {
    id: "content-label",
    collectionId: "semantic",
    name: "Content/Primary action",
    type: "string",
    values: { light: "继续", dark: "继续" },
    description: "",
    codeSyntax: "",
    scopes: ["text"],
  };
  system.variables["content-visible"] = {
    id: "content-visible",
    collectionId: "semantic",
    name: "Visibility/Content",
    type: "boolean",
    values: { light: true, dark: true },
    description: "",
    codeSyntax: "",
    scopes: ["visible"],
  };
  system.styles = {
    "paint-surface": {
      id: "paint-surface",
      kind: "paint",
      name: "Surface/Default",
      description: "",
      properties: { fill: "#ffffff", fillOpacity: 1 },
      bindings: { fill: "color-surface" },
    },
    "paint-accent": {
      id: "paint-accent",
      kind: "paint",
      name: "Brand/Accent",
      description: "",
      properties: { fill: "#246bfd", fillOpacity: 1 },
      bindings: { fill: "color-accent" },
    },
    "paint-canvas": {
      id: "paint-canvas",
      kind: "paint",
      name: "Surface/Canvas",
      description: "",
      properties: { fill: "#f3f5f9", fillOpacity: 1 },
      bindings: { fill: "color-canvas" },
    },
    "text-title": {
      id: "text-title",
      kind: "text",
      name: "Heading/Large",
      description: "",
      properties: {
        fontSize: 28,
        fontWeight: 700,
        lineHeight: 38,
        letterSpacing: -0.5,
      },
      bindings: { fontSize: "text-title", fontFamily: "font-family" },
    },
    "text-body": {
      id: "text-body",
      kind: "text",
      name: "Body/Regular",
      description: "",
      properties: {
        fontSize: 16,
        fontWeight: 400,
        lineHeight: 24,
        letterSpacing: 0,
      },
      bindings: { fontSize: "text-body", fontFamily: "font-family" },
    },
    "text-caption": {
      id: "text-caption",
      kind: "text",
      name: "Caption/Medium",
      description: "",
      properties: {
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 18,
        letterSpacing: 0,
      },
      bindings: { fontFamily: "font-family" },
    },
    "effect-card": {
      id: "effect-card",
      kind: "effect",
      name: "Elevation/Card",
      description: "",
      properties: {
        shadows: [
          {
            x: 0,
            y: 4,
            blur: 20,
            spread: -4,
            color: "#192234",
            opacity: 0.14,
            inset: false,
          },
        ],
      },
      bindings: {},
    },
    "effect-glass": {
      id: "effect-glass",
      kind: "effect",
      name: "Material/Glass",
      description: "",
      properties: {
        backdropBlur: 24,
        shadows: [
          {
            x: 0,
            y: 8,
            blur: 32,
            spread: -8,
            color: "#102040",
            opacity: 0.18,
            inset: false,
          },
        ],
      },
      bindings: {},
    },
  };
  return system;
}
