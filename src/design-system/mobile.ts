import { mobileAppearanceSystem, bindMobileVariant } from "./mobile-appearance";
import { mediaDefinitions } from "./mobile-media";
import { parseLibrary, type ComponentLibrary } from "../domain/library-schema";
import { controlDefinitions, type VariantProps } from "./mobile-controls";
import { surfaceDefinitions } from "./mobile-surfaces";
import { mobileThemes, type Appearance } from "./mobile-foundations";
export const MOBILE_LIBRARY_ID = "forma-mobile-v1";
function combinations(axes: Record<string, readonly string[]>): VariantProps[] {
  return Object.entries(axes).reduce<VariantProps[]>(
    (all, [key, values]) =>
      all.flatMap((p) => values.map((value) => ({ ...p, [key]: value }))),
    [{}],
  );
}
const definitions = [
  ...controlDefinitions,
  ...surfaceDefinitions,
  ...mediaDefinitions,
];
export const mobileLibrary: ComponentLibrary = parseLibrary({
  format: "forma/library",
  version: 1,
  id: MOBILE_LIBRARY_ID,
  name: "Forma Mobile",
  revision: 2,
  designSystem: mobileAppearanceSystem(),
  description:
    "自研移动端与平板 UI 组件。以常见移动交互模式组织；非 Apple 官方套件，不包含 Apple 字体、图标或原始组件。",
  source: {
    name: "Forma 原生设计系统",
    license:
      "项目自研组件；与项目代码一同使用，不包含 Apple Design Resources。",
  },
  components: definitions.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    description: d.description,
    variants: (["Light", "Dark"] as Appearance[]).flatMap((appearance) =>
      combinations(d.axes ?? {}).map((p) => {
        const properties = { Appearance: appearance, ...p },
          b = d.build(appearance, p);
        bindMobileVariant(b.nodes, appearance);
        return {
          id: Object.values(properties).join("-"),
          name: Object.values(properties).join(" / "),
          properties,
          nodes: b.nodes,
        };
      }),
    ),
  })),
});
export const mobileTokens = Object.fromEntries(
  Object.entries(mobileThemes).flatMap(([mode, values]) =>
    Object.entries(values).map(([name, value]) => [
      `mobile-${mode.toLowerCase()}-${name}`,
      { name: `Mobile/${mode}/${name}`, value },
    ]),
  ),
);
export function mobileComponentLibrary(id: string): ComponentLibrary {
  return {
    ...mobileLibrary,
    components: mobileLibrary.components.filter((c) => c.id === id),
  };
}
