import { layerComponent } from "../domain/component-slots";
import { stableHash } from "../domain/stable-hash";
import type { DesignDocument } from "../domain/document";
import type { RuntimeNode } from "../runtime/FormaRuntime";

/** Keep imports stable across renames, page reorders and revision updates. */
function componentModuleName(libraryId: string, componentId: string) {
  const hash = stableHash(JSON.stringify([libraryId, componentId]));
  const slug =
    componentId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .slice(0, 40) || "component";
  return slug + "-" + hash;
}

export function pageComponentImports(doc: DesignDocument) {
  const paths = new Map<string, string>();
  for (const node of doc.nodes) {
    const source = layerComponent(doc, node);
    if (!source) continue;
    const { libraryId, componentId } = source;
    paths.set(
      JSON.stringify([libraryId, componentId]),
      componentModuleName(libraryId, componentId),
    );
  }
  return [...paths].map(([key, path], index) => ({
    key,
    path,
    local: "Component" + index,
  }));
}

export function componentProjectFiles(
  doc: DesignDocument,
  compile: (page: DesignDocument) => RuntimeNode[],
) {
  const files: Record<string, string> = {};
  const used = new Set<string>();
  for (const node of [
    ...doc.nodes,
    ...(doc.pages ?? []).flatMap((p) => p.nodes ?? []),
  ]) {
    const source = layerComponent(doc, node);
    if (source)
      used.add(JSON.stringify([source.libraryId, source.componentId]));
  }
  for (const library of Object.values(doc.libraries ?? {})) {
    for (const component of library.components) {
      if (!used.has(JSON.stringify([library.id, component.id]))) continue;
      const path =
        "src/components/" +
        componentModuleName(library.id, component.id) +
        ".tsx";
      if (files[path]) throw Error("组件模块路径冲突：" + component.name);
      const variants = Object.fromEntries(
        component.variants.map((variant) => {
          const template = {
            ...doc,
            pages: undefined,
            activePage: undefined,
            nodes: variant.nodes,
          };
          return [variant.id, compile(template)[0]];
        }),
      );
      const hasImages = component.variants.some((v) =>
        v.nodes.some((n) => n.image),
      );
      const hasAxes = component.variants.some(
        (v) => Object.keys(v.properties).length,
      );
      const variantSelectors = hasAxes
        ? [
            "export const variantProperties = " +
              JSON.stringify(
                Object.fromEntries(
                  component.variants.map((v) => [v.id, v.properties]),
                ),
                null,
                2,
              ) +
              " as const;",
            "export type VariantProperties = (typeof variantProperties)[Variant];",
            "type Choice = { variant?: Variant; variantProperties?: never } | { variant?: never; variantProperties: VariantProperties };",
            "function variantId(choice: Choice): Variant {",
            "  if (!choice.variantProperties) return choice.variant ?? " +
              JSON.stringify(component.variants[0].id) +
              ";",
            "  const wanted: Record<string,string> = choice.variantProperties;",
            "  const matches = (Object.keys(variantProperties) as Variant[]).filter(id => {",
            "    const props = Object.entries(variantProperties[id]);",
            "    return props.length === Object.keys(wanted).length && props.every(([key,value]) => wanted[key] === value);",
            "  });",
            '  if (matches.length !== 1) throw Error(componentName + "：找不到唯一的变体属性组合，请检查属性或指定 variant。");',
            "  return matches[0];",
            "}",
          ]
        : ["type Choice = { variant?: Variant };"];
      const fields = (component.exposed ?? []).map(
        ({ name, previousNames, kind, target }) => ({
          names: [name, ...(previousNames ?? [])],
          kind,
          target,
        }),
      );
      files[path] = [
        'import { DesignNodeContent, instanceTemplate, type RuntimeNode, type DesignAction } from "../FormaRuntime";',
        ...(hasImages
          ? [
              'import { ImageResources } from "../FormaRuntime";',
              'import images from "../design-images";',
            ]
          : []),
        'import "../tokens.css";',
        "export const componentName = " + JSON.stringify(component.name) + ";",
        "export type Variant = " +
          component.variants.map((v) => JSON.stringify(v.id)).join(" | ") +
          ";",
        "const variants: Record<Variant, RuntimeNode> = " +
          JSON.stringify(variants, null, 2) +
          ";",
        "export type ComponentValues = {" +
          fields
            .flatMap((field) =>
              field.names.map(
                (name) =>
                  JSON.stringify(name) +
                  "?: " +
                  (field.kind === "text"
                    ? "string"
                    : field.kind === "swap"
                      ? 'import("react").ReactNode'
                      : "boolean"),
              ),
            )
            .join("; ") +
          "};",
        "const fields: {names: (keyof ComponentValues)[]; kind: string; target: string}[] = " +
          JSON.stringify(fields) +
          ";",
        ...variantSelectors,
        "type Props = { node: RuntimeNode; onAction?: DesignAction } | (Choice & { instanceId: string; values?: ComponentValues; text?: Record<string, string>; onAction?: DesignAction });",
        "export default function DesignComponent(props: Props) {",
        '  const text: Record<string,string> = "text" in props ? {...props.text} : {};',
        "  const visibility: Record<string,boolean> = {};",
        '  const slots: Record<string,import("react").ReactNode> = {};',
        '  if ("values" in props && props.values) for (const field of fields) {',
        "    const key = field.names.find(name => Object.prototype.hasOwnProperty.call(props.values, name));",
        "    if (key === undefined) continue;",
        "    const value = props.values[key];",
        '    if (typeof value === "string" && field.kind === "text") text[field.target] = value;',
        '    if (typeof value === "boolean" && field.kind === "visible") visibility[field.target] = value;',
        '    if (field.kind === "swap" && value !== undefined) slots[field.target] = value;',
        "  }",
        '  const node = "node" in props ? props.node : instanceTemplate(variants[' +
          (hasAxes
            ? "variantId(props)"
            : "props.variant ?? " + JSON.stringify(component.variants[0].id)) +
          "], props.instanceId, text, visibility, slots);",
        "  return " +
          (hasImages
            ? "<ImageResources.Provider value={images}><DesignNodeContent node={node} onAction={props.onAction}/></ImageResources.Provider>"
            : "<DesignNodeContent node={node} onAction={props.onAction}/>") +
          ";",
        "}",
        "",
      ].join("\n");
    }
  }
  return files;
}
