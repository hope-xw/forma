import type { Operation } from "../domain/commands";
import type { DesignDocument } from "../domain/document";
import type { Point } from "../domain/geometry";
import type { ComponentLibrary } from "../domain/library-schema";
import {
  ANTD5_LIBRARY_ID,
  antd5Library,
  antd5Spacing,
  antd5Templates,
  antd5Themes,
  antd5Tokens,
  antd5Typography,
  createAntd5Template,
} from "./antd5";
import type {
  Appearance,
  KitScaleSpec,
  KitTemplateMeta,
  KitTypographySpec,
  LibraryPlatform,
} from "./kit-builder";
import {
  MATERIAL3_LIBRARY_ID,
  createMaterial3Template,
  material3Library,
  material3Spacing,
  material3Templates,
  material3Themes,
  material3Tokens,
  material3Typography,
} from "./material3";
import { MOBILE_LIBRARY_ID, mobileLibrary, mobileTokens } from "./mobile";
import { mobileThemes, mobileTypography } from "./mobile-foundations";
import { createMobileTemplate, mobileTemplates } from "./mobile-templates";
import {
  SHADCN_LIBRARY_ID,
  createShadcnTemplate,
  shadcnLibrary,
  shadcnSpacing,
  shadcnTemplates,
  shadcnThemes,
  shadcnTokens,
  shadcnTypography,
} from "./shadcn";

export type { Appearance, LibraryPlatform };

export interface BuiltinFoundationToken {
  id: string;
  label: string;
  fullName: string;
  value: string;
}

export interface BuiltinLibraryEntry {
  id: string;
  name: string;
  shortName: string;
  platform: LibraryPlatform;
  platformLabel: string;
  accent: string;
  swatches: readonly string[];
  summary: string;
  defaultEnabled: boolean;
  library: ComponentLibrary;
  tokens: Record<string, { name: string; value: string }>;
  getAppearanceTokens: (appearance: Appearance) => BuiltinFoundationToken[];
  typography: readonly KitTypographySpec[];
  scales: readonly KitScaleSpec[];
  templates: readonly KitTemplateMeta[];
  createTemplate: (
    doc: DesignDocument,
    templateId: string,
    appearance: Appearance,
    origin: Point,
  ) => { operations: Operation[]; id: string };
}

const mobileScales: readonly KitScaleSpec[] = [
  { name: "Radius SM", value: "8px", kind: "radius" },
  { name: "Radius MD", value: "14px", kind: "radius" },
  { name: "Radius LG", value: "20px", kind: "radius" },
  { name: "Radius Sheet", value: "28px", kind: "radius" },
  { name: "Space SM", value: "8px", kind: "spacing" },
  { name: "Space MD", value: "16px", kind: "spacing" },
];

const mobileTemplateList: readonly KitTemplateMeta[] = mobileTemplates.map(
  (t) => ({
    id: t.id,
    libraryId: MOBILE_LIBRARY_ID,
    name: t.name,
    description: t.description,
    width: t.width,
    height: t.height,
    platform: "ios",
  }),
);

function filterAppearanceTokens(
  tokens: Record<string, { name: string; value: string }>,
  appearance: Appearance,
): BuiltinFoundationToken[] {
  const needle = `-${appearance.toLowerCase()}-`;
  return Object.entries(tokens)
    .filter(([id]) => id.includes(needle))
    .map(([id, token]) => ({
      id,
      label: token.name.split("/").at(-1) ?? token.name,
      fullName: token.name,
      value: token.value,
    }));
}

export const BUILTIN_LIBRARIES: readonly BuiltinLibraryEntry[] = [
  {
    id: MOBILE_LIBRARY_ID,
    name: mobileLibrary.name,
    shortName: "iOS · Mobile",
    platform: "ios",
    platformLabel: "iOS / iPadOS",
    accent: mobileThemes.Light.accent,
    swatches: [
      mobileThemes.Light.accent,
      mobileThemes.Light.success,
      mobileThemes.Light.danger,
      mobileThemes.Light.text,
      mobileThemes.Light.canvas,
    ],
    summary:
      "44 类原生移动与平板组件（参考 Apple HIG 组织方式），含导航栏、表单元件、玻璃浮层与 4 套整页模板。",
    defaultEnabled: true,
    library: mobileLibrary,
    tokens: mobileTokens,
    getAppearanceTokens: (appearance) =>
      filterAppearanceTokens(mobileTokens, appearance),
    typography: mobileTypography,
    scales: mobileScales,
    templates: mobileTemplateList,
    createTemplate: createMobileTemplate,
  },
  {
    id: MATERIAL3_LIBRARY_ID,
    name: material3Library.name,
    shortName: "Android · M3",
    platform: "android",
    platformLabel: "Android / M3",
    accent: material3Themes.Light.primary,
    swatches: [
      material3Themes.Light.primary,
      material3Themes.Light.primaryContainer,
      material3Themes.Light.secondaryContainer,
      material3Themes.Light.error,
      material3Themes.Light.surfaceContainer,
    ],
    summary:
      "Android Material Design 3 风格组件体系，含药丸按钮、FAB、芯片、底部导航胶囊、对话框与 M3 色阶变量。",
    defaultEnabled: false,
    library: material3Library,
    tokens: material3Tokens,
    getAppearanceTokens: (appearance) =>
      filterAppearanceTokens(material3Tokens, appearance),
    typography: material3Typography,
    scales: material3Spacing,
    templates: material3Templates,
    createTemplate: createMaterial3Template,
  },
  {
    id: ANTD5_LIBRARY_ID,
    name: antd5Library.name,
    shortName: "AntD 5 · 中后台",
    platform: "web-enterprise",
    platformLabel: "Web 中后台",
    accent: antd5Themes.Light.colorPrimary,
    swatches: [
      antd5Themes.Light.colorPrimary,
      antd5Themes.Light.colorSuccess,
      antd5Themes.Light.colorWarning,
      antd5Themes.Light.colorError,
      antd5Themes.Light.colorBgLayout,
    ],
    summary:
      "Ant Design 5 企业级中后台组件体系，覆盖表单录入、侧边菜单、步骤条、分页、数据表格与 1440px 工作台模板。",
    defaultEnabled: false,
    library: antd5Library,
    tokens: antd5Tokens,
    getAppearanceTokens: (appearance) =>
      filterAppearanceTokens(antd5Tokens, appearance),
    typography: antd5Typography,
    scales: antd5Spacing,
    templates: antd5Templates,
    createTemplate: createAntd5Template,
  },
  {
    id: SHADCN_LIBRARY_ID,
    name: shadcnLibrary.name,
    shortName: "shadcn · 现代 Web",
    platform: "web-modern",
    platformLabel: "现代 Web / SaaS",
    accent: shadcnThemes.Light.primary,
    swatches: [
      shadcnThemes.Light.primary,
      shadcnThemes.Light.mutedForeground,
      shadcnThemes.Light.secondary,
      shadcnThemes.Light.destructive,
      shadcnThemes.Light.success,
    ],
    summary:
      "shadcn/ui 现代极简 SaaS 组件体系，含 Zinc 明暗中性色板、命令面板、侧栏导航、通知与设置/定价页模板。",
    defaultEnabled: false,
    library: shadcnLibrary,
    tokens: shadcnTokens,
    getAppearanceTokens: (appearance) =>
      filterAppearanceTokens(shadcnTokens, appearance),
    typography: shadcnTypography,
    scales: shadcnSpacing,
    templates: shadcnTemplates,
    createTemplate: createShadcnTemplate,
  },
];

export const DEFAULT_ENABLED_BUILTIN_IDS: readonly string[] =
  BUILTIN_LIBRARIES.filter((entry) => entry.defaultEnabled).map(
    (entry) => entry.id,
  );

export { OFFICIAL_BUILTIN_LIBRARY_IDS as BUILTIN_LIBRARY_IDS } from "../domain/library-schema";

export const BUILTIN_TEMPLATES: readonly KitTemplateMeta[] =
  BUILTIN_LIBRARIES.flatMap((entry) => entry.templates);

export function findBuiltinEntry(id: string): BuiltinLibraryEntry | undefined {
  return BUILTIN_LIBRARIES.find((entry) => entry.id === id);
}

export function findBuiltinLibrary(id: string): ComponentLibrary | undefined {
  return findBuiltinEntry(id)?.library;
}

export function createBuiltinTemplate(
  doc: DesignDocument,
  templateId: string,
  appearance: Appearance,
  origin: Point,
): { operations: Operation[]; id: string } {
  const entry = BUILTIN_LIBRARIES.find((item) =>
    item.templates.some((t) => t.id === templateId),
  );
  if (!entry) throw new Error("模板不存在：" + templateId);
  return entry.createTemplate(doc, templateId, appearance, origin);
}
