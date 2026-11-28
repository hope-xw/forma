/// <reference types="vite/client" />

declare const __FORMA_VERSION__: string;
interface FormaBoundFile {
  filePath: string;
  fileName: string;
}

type DesktopFileAction =
  "save" | "saveAs" | "newTab" | "closeTab" | "reopenTab";
interface DesktopOpenFileInfo {
  name: string;
  nativePath?: string | null;
}

interface SystemFontRequest {
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  text: string;
  maxFaces?: number;
  declaredOnly?: boolean;
  excludeFaces?: string[];
}
interface SystemFontFace {
  family: string;
  faceIndex: number;
  format: "ttf" | "otf" | "ttc" | "otc";
  data: Uint8Array | string;
}
declare module "*/system-fonts.mjs" {
  export function parseFontFamilies(
    css: string,
  ): { css: string; name: string; quoted: boolean }[];
  export function resolveSystemFonts(
    req: SystemFontRequest,
  ): Promise<ResolvedSystemFontFace[]>;
  export function listSystemFontFamilies(): Promise<string[]>;
}
declare module "wawoff2/decompress.js" {
  export default function decompress(bytes: Uint8Array): Promise<Uint8Array>;
}
interface ResolvedSystemFontFace extends SystemFontFace {
  faceId: string;
  familyRank: number;
  declaredMatch: boolean;
  faceIndex: 0;
  format: "ttf" | "otf";
  data: string;
}
type SystemFontFailure = { ok: false; code?: string; error: string };
type DesktopSystemFontResult = ResolvedSystemFontFace[] | SystemFontFailure;

interface FormaDesktopBridge {
  resolveSystemFonts(req: SystemFontRequest): Promise<DesktopSystemFontResult>;
  version: string;
  platform: string;
  agentConfigured: boolean;
  hasConfiguredAgent(): Promise<boolean>;
  bindPendingFile(fileKey: string): Promise<FormaBoundFile | null>;
  getBoundFile(fileKey?: string): Promise<FormaBoundFile | null>;
  saveNativeFile(options: {
    bytes: Uint8Array;
    suggestedName: string;
    fileKey?: string;
    saveAs?: boolean;
  }): Promise<
    ({ saved: true } & FormaBoundFile) | { saved: false; canceled: true }
  >;
  localLibraryAddress(): Promise<string>;
  openInNewWindow(query: string): Promise<void>;
  closeCurrentWindow(): Promise<void>;
  onOpenFileInTab(listener: (info: DesktopOpenFileInfo) => void): () => void;
  onMenuAction(
    listener: (
      action:
        | "undo"
        | "redo"
        | "selectAll"
        | "zoom100"
        | "fit"
        | "fitSelection"
        | "rulers",
    ) => void,
    fileActionListener?: (action: DesktopFileAction) => void,
  ): () => void;
  readPendingChunk(): Promise<Uint8Array<ArrayBuffer>>;
  consumePendingFile(): Promise<
    (DesktopOpenFileInfo & { size: number }) | null
  >;
}

interface Window {
  formaDesktop?: FormaDesktopBridge;
  queryLocalFonts?(): Promise<
    {
      family: string;
      fullName: string;
      postscriptName: string;
      style: string;
      blob(): Promise<Blob>;
    }[]
  >;
}
