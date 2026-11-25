/// <reference types="vite/client" />

declare const __FORMA_VERSION__: string;

interface FormaDesktopBridge {
  version: string;
  platform: string;
  localLibraryAddress(): Promise<string>;
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
  ): () => void;
  readPendingChunk(): Promise<Uint8Array<ArrayBuffer>>;
  consumePendingFile(): Promise<{
    name: string;
    size: number;
  } | null>;
}

interface Window {
  formaDesktop?: FormaDesktopBridge;
}
