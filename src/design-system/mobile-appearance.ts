import type { DesignNode, DesignDocument } from "../domain/document";
import { emptyDesignSystem } from "../domain/design-system-schema";
import { mobileThemes, type Appearance } from "./mobile-foundations";

const collectionId = "mobile-appearance";
export function mobileAppearanceSystem() {
  const system = emptyDesignSystem();
  system.collections[collectionId] = {
    id: collectionId,
    name: "Mobile Appearance",
    defaultModeId: "light",
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  };
  for (const key of Object.keys(
    mobileThemes.Light,
  ) as (keyof typeof mobileThemes.Light)[]) {
    const id = "mobile-color-" + key;
    system.variables[id] = {
      id,
      name: "Mobile/" + key,
      collectionId,
      type: "color",
      description: "",
      codeSyntax: "--" + id,
      scopes: ["fill", "color", "stroke"],
      values: { light: mobileThemes.Light[key], dark: mobileThemes.Dark[key] },
    };
  }
  return system;
}
/** Keep authored artwork and foreground whites independent of theme surfaces. */
export function bindMobileAppearance(n: DesignNode, appearance: Appearance) {
  const palette = mobileThemes[appearance];
  for (const key of ["color", "fill", "stroke"] as const) {
    if (key === "color" && !["vector", "text", "button"].includes(n.type))
      continue;
    if (
      key === "fill" &&
      (["vector", "text", "group"].includes(n.type) ||
        n.style.fillOpacity === 0)
    )
      continue;
    if (key === "stroke" && !n.style.strokeWidth) continue;
    const match = Object.entries(palette).find(
      ([role, hex]) =>
        hex === n.style[key] &&
        (key !== "color" || !["canvas", "surface"].includes(role)) &&
        (role !== "surface" || n.type === "frame"),
    );
    if (match && !n.variableBindings?.[key] && !n.styleBindings?.paint)
      (n.variableBindings ??= {})[key] = "mobile-color-" + match[0];
  }
}
export function bindMobileVariant(nodes: DesignNode[], appearance: Appearance) {
  for (const node of nodes) {
    bindMobileAppearance(node, appearance);
    if (!node.parentId)
      (node.variableModes ??= {})[collectionId] = appearance.toLowerCase();
  }
}
export function themeMobileStudio(doc: DesignDocument) {
  const library = doc.libraries?.["forma-mobile-v1"];
  if (!library || !doc.designSystem) return doc;
  const system = mobileAppearanceSystem();
  Object.assign(doc.designSystem.collections, system.collections);
  Object.assign(doc.designSystem.variables, system.variables);
  library.designSystem = system;
  library.revision = 2;
  for (const component of library.components)
    for (const v of component.variants)
      bindMobileVariant(
        v.nodes,
        v.properties.Appearance === "Dark" ? "Dark" : "Light",
      );
  for (const page of doc.pages ?? []) {
    const nodes = page.nodes ?? doc.nodes,
      byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      let parent: DesignNode | undefined = n;
      while (parent?.parentId && !parent.instance)
        parent = byId.get(parent.parentId);
      if (!parent) continue;
      if (parent.instance?.libraryId === library.id) {
        const mode = parent.instance.variantId.startsWith("Dark")
          ? "Dark"
          : "Light";
        bindMobileAppearance(n, mode);
        if (n === parent)
          (n.variableModes ??= {})[collectionId] = mode.toLowerCase();
      } else if (!parent.instance && ["iphone", "sound"].includes(page.id)) {
        const mode =
          parent.name.includes("Dark") ||
          parent.style.fill === mobileThemes.Dark.canvas
            ? "Dark"
            : "Light";
        bindMobileAppearance(n, mode);
        if (n === parent)
          (n.variableModes ??= {})[collectionId] = mode.toLowerCase();
      }
    }
  }
  const atlas = doc.pages?.find((p) => p.id === "atlas")?.nodes;
  if (atlas) {
    const brand = emptyDesignSystem(),
      collection = "atlas-brand";
    brand.collections[collection] = {
      id: collection,
      name: "Atlas / Brand",
      defaultModeId: "base",
      modes: [{ id: "base", name: "Base" }],
    };
    const colors = {
      ink: "#172f2b",
      muted: "#5d7069",
      paper: "#fbfaf4",
      forest: "#1c594a",
      orange: "#bb552c",
    };
    for (const [name, value] of Object.entries(colors)) {
      const id = "atlas-" + name;
      brand.variables[id] = {
        id,
        name: "Atlas/" + name,
        collectionId: collection,
        type: "color",
        description: "",
        codeSyntax: "--" + id,
        scopes: ["fill", "color", "stroke"],
        values: { base: value },
      };
    }
    const bind = (n: DesignNode) => {
      for (const key of ["fill", "color", "stroke"] as const) {
        if (key === "color" && !["text", "vector", "button"].includes(n.type))
          continue;
        if (
          key === "fill" &&
          (n.style.fillOpacity === 0 || ["text", "vector"].includes(n.type))
        )
          continue;
        const role = Object.entries(colors).find(
          ([, value]) => value === n.style[key],
        )?.[0];
        if (role) (n.variableBindings ??= {})[key] = "atlas-" + role;
      }
    };
    atlas.forEach(bind);
    Object.assign(doc.designSystem.collections, brand.collections);
    Object.assign(doc.designSystem.variables, brand.variables);
    const waypoints = doc.libraries?.["field-atlas-waypoints"];
    if (waypoints) {
      waypoints.designSystem = brand;
      for (const c of waypoints.components)
        for (const v of c.variants) v.nodes.forEach(bind);
    }
  }
  return doc;
}
