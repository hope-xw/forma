import { themeMobileStudio } from "../src/design-system/mobile-appearance";
import { mkdirSync, writeFileSync } from "node:fs";
import { createStarter } from "../src/domain/seed";
import { parseDocument, type DesignDocument } from "../src/domain/document";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { ipadExample } from "../src/design-system/ipad-examples";
import { createMobileTemplate } from "../src/design-system/mobile-templates";
import { mobileComponentLibrary } from "../src/design-system/mobile";
import { instantiateComponent, installLibrary } from "../src/domain/library";
import { transact, type Operation } from "../src/domain/commands";
import { openPage } from "../src/domain/pages";
import { addFieldAtlas } from "../src/design-system/field-atlas";
import { wireStudio } from "./studio-interactions";
const empty = (): DesignDocument => ({
  ...createStarter(),
  name: "Forma Mobile · 界面研究室",
  nodes: [],
  designSystem: nativeDesignSystem(),
});
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
function overlay(
  doc: DesignDocument,
  component: string,
  parent: string,
  x: number,
  y: number,
  appearance: string,
) {
  const library = mobileComponentLibrary(component),
    variant = library.components[0].variants.find(
      (item) => item.properties.Appearance === appearance,
    )!;
  return apply(
    doc,
    instantiateComponent(doc, library, component, variant.id, parent, { x, y })
      .operations,
  );
}
let tablet = empty(),
  phone = empty(),
  media = empty();
for (const [i, kind] of (
  ["sidebar", "share", "menu", "share", "context"] as const
).entries()) {
  const x = (i % 2) * 1310,
    y = Math.floor(i / 2) * 950,
    appearance = i === 3 ? "Dark" : "Light";
  const layers = ipadExample(kind, appearance, x, y);
  tablet.nodes.push(...layers);
  if (kind === "menu")
    tablet = overlay(
      tablet,
      "context-menu",
      layers[0].id,
      x + 305,
      y + 238,
      appearance,
    );
}
for (const [i, kind] of [
  "settings",
  "settings",
  "explore",
  "explore",
].entries()) {
  const x = i * 454,
    appearance = i >= 2 ? "Dark" : "Light";
  const board = createMobileTemplate(phone, kind, appearance, { x, y: 0 });
  phone = apply(phone, board.operations);
  if (i % 2 === 1) {
    phone = overlay(
      phone,
      i === 1 ? "action-sheet" : "activity-view",
      board.id,
      x + (i === 1 ? 16 : 0),
      i === 1 ? 510 : 496,
      appearance,
    );
    phone.nodes.find((n) => n.id === board.id)!.name +=
      i === 1 ? " / 操作菜单" : " / 分享面板";
  }
}
for (const [i, appearance] of (["Light", "Dark"] as const).entries())
  media = apply(
    media,
    createMobileTemplate(media, "music", appearance, { x: i * 1520, y: 0 })
      .operations,
  );
for (const library of [
  ...Object.values(phone.libraries ?? {}),
  ...Object.values(media.libraries ?? {}),
]) {
  const merged = installLibrary(tablet, library);
  tablet.libraries = { ...tablet.libraries, [merged.id]: merged };
}
const document = parseDocument(
  themeMobileStudio(
    addFieldAtlas(
      wireStudio({
        ...tablet,
        revision: 0,
        activePage: "ipad",
        pages: [
          { id: "ipad", name: "01  iPad · 工作空间" },
          { id: "iphone", name: "02  iPhone · 发现与设置", nodes: phone.nodes },
          { id: "sound", name: "03  Soundspace · 音乐", nodes: media.nodes },
        ],
      }),
    ),
  ),
);
mkdirSync("public/examples", { recursive: true });
writeFileSync(
  "public/examples/mobile-studio.forma.json",
  JSON.stringify(document),
);
console.table(
  document.pages!.map((p) => {
    const nodes = openPage(document, p.id).nodes;
    return {
      page: p.name,
      boards: nodes.filter((n) => !n.parentId).length,
      layers: nodes.length,
      icons: nodes.filter((n) => n.type === "vector").length,
      instances: nodes.filter((n) => n.instance).length,
    };
  }),
);
