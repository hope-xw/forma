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

interface FormaDesktopBridge {
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
}
