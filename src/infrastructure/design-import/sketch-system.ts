import { limitedText, importName } from "./types";
import { styleGroups } from "../../domain/design-properties";
import {
  emptyDesignSystem,
  type ReusableStyle,
} from "../../domain/design-system-schema";
import type { DesignNode, NodeStyle } from "../../domain/node";
import {
  appearance,
  orderedFills,
  type SketchFontContext,
} from "./sketch-appearance";
import {
  array,
  object,
  string,
  color,
  alpha,
  idFor,
  type Fields,
  type Warn,
} from "./sketch-source";

export function readSystem(
  doc: Fields,
  warn: Warn,
  fontContext?: SketchFontContext,
) {
  const system = emptyDesignSystem();
  const styleRefs = new Map<string, NonNullable<DesignNode["styleBindings"]>>();
  const names = new Set<string>();
  function unique(group: string, name: string, id: string) {
    const base = importName(name, id, 200, (msg) => warn(id, msg));
    let result = base,
      serial = 0;
    while (names.has(group + "/" + result)) {
      warn(id, "同一分类中有同名定义，附加源 ID 以区分");
      const suffix = " · " + id + (serial ? "-" + serial : "");
      result = limitedText(base, 200 - suffix.length) + suffix;
      serial++;
    }
    names.add(group + "/" + result);
    return result;
  }
  function swatch(s: Fields, group: string, label: string) {
    const id = string(s.do_objectID);
    if (!id || id in system.variables)
      throw Error("Sketch 色变量 ID 无效或重复");
    const collection = idFor("colors", group);
    system.collections[collection] ??= {
      id: collection,
      name: importName(label, "外部色变量", 100, (msg) => warn(id, msg)),
      defaultModeId: "default",
      modes: [{ id: "default", name: "默认" }],
    };
    system.activeModes[collection] = "default";
    system.variables[id] = {
      id,
      name: unique(collection, string(s.name, id), id),
      type: "color",
      collectionId: collection,
      values: { default: color(s.value) },
      scopes: [],
      description: "",
      codeSyntax: "",
    };
    if (alpha(s.value) !== 1)
      warn(id, "色变量透明度保留在引用图层，变量值采用 RGB");
  }
  for (const s of array(object(doc.sharedSwatches).objects))
    swatch(s, "local", "Sketch 色变量");
  for (const f of array(doc.foreignSwatches))
    swatch(
      object(f.localSwatch),
      string(f.libraryID, "foreign"),
      string(f.sourceLibraryName, "外部色变量"),
    );
  function shared(s: Fields, text: boolean) {
    const id = string(s.do_objectID);
    if (!id || styleRefs.has(id)) throw Error("Sketch 共享样式 ID 无效或重复");
    const props = appearance(
      object(s.value),
      (msg) => warn(id, msg),
      fontContext,
    );
    const refs: NonNullable<DesignNode["styleBindings"]> = {};
    for (const kind of (text
      ? ["text"]
      : ["paint", "stroke", "effect"]) as ReusableStyle["kind"][]) {
      const properties: Partial<NodeStyle> = {};
      for (const k of styleGroups[kind])
        if (props[k] !== undefined)
          Object.assign(properties, { [k]: props[k] });
      if (
        !Object.keys(properties).length &&
        (kind === "effect" || kind === "stroke")
      )
        continue;
      const key = idFor(kind, id);
      const value = object(s.value);
      const firstColor = object(orderedFills(value)[0]?.fill.color);
      const borderColor = object(
        array(value.borders)
          .filter((b) => b.isEnabled !== false)
          .at(-1)?.color,
      );
      const textColor = object(
        object(object(value.textStyle).encodedAttributes)
          .MSAttributedStringColorAttribute,
      );
      const sid = string(
        kind === "paint"
          ? firstColor.swatchID
          : kind === "stroke"
            ? borderColor.swatchID
            : kind === "text"
              ? textColor.swatchID
              : undefined,
      );
      const bindings: ReusableStyle["bindings"] = {};
      if (sid && Object.hasOwn(system.variables, sid))
        bindings[
          kind === "text" ? "color" : kind === "stroke" ? "stroke" : "fill"
        ] = sid;
      else if (sid) warn(id, "共享样式引用缺少颜色变量：" + sid);
      system.styles[key] = {
        id: key,
        kind,
        properties,
        bindings,
        description: "",
        name: unique(kind, string(s.name, id), id),
      };
      refs[kind] = key;
    }
    styleRefs.set(id, refs);
  }
  for (const s of array(object(doc.layerStyles).objects)) shared(s, false);
  for (const s of array(object(doc.layerTextStyles).objects)) shared(s, true);
  for (const f of array(doc.foreignLayerStyles))
    shared(object(f.localSharedStyle), false);
  for (const f of array(doc.foreignTextStyles))
    shared(object(f.localSharedStyle), true);
  return { system, styleRefs };
}
