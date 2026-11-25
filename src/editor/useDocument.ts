import { useCallback, useEffect, useRef, useState } from "react";
import { commitEditorOperations } from "../application/geometry-preview";
import { commit, travel, type History } from "../application/history";
import type { Operation } from "../domain/commands";
import { parseDocument, type DesignDocument } from "../domain/document";
import { createStarter } from "../domain/seed";
import { openPage } from "../domain/pages";
import {
  BrowserDocumentRepository,
  download,
  type DocumentRepository,
} from "../infrastructure/storage";
const defaultRepository = new BrowserDocumentRepository();
export interface EditorFileOptions {
  externalFile?: File;
  repository?: DocumentRepository;
  fileKey?: string;
  initialSaved?: boolean;
  initialSelection?: string[];
  initialDocument?: DesignDocument;
  loadError?: string;
}
export function useDocument({
  repository = defaultRepository,
  initialDocument,
  initialSaved = true,
  loadError = "",
}: EditorFileOptions = {}) {
  const [initial] = useState(() => ({
    document: initialDocument ?? createStarter(),
    error: loadError,
  }));
  const [history, setHistory] = useState<History>({
    present: initial.document,
    past: [],
    future: [],
  });
  const historyRef = useRef(history);
  historyRef.current = history;
  const [error, setError] = useState(initial.error);
  const [savedDocument, setSavedDocument] = useState<DesignDocument | null>(
    initialSaved ? (initialDocument ?? null) : null,
  );
  const [protectCache, setProtectCache] = useState(!!initial.error);
  const [preview, setPreview] = useState<DesignDocument | null>(null);
  const pending = useRef<{
    doc: DesignDocument;
    promise: Promise<void>;
  } | null>(null);
  const saveLatest = useCallback(
    (doc: DesignDocument) => {
      if (pending.current?.doc === doc) return pending.current.promise;
      const promise = repository.save(doc);
      pending.current = { doc, promise };
      return promise;
    },
    [repository],
  );
  const saved = !protectCache && savedDocument === history.present;
  useEffect(() => {
    if (protectCache || saved) return;
    let active = true;
    const doc = history.present;
    const delay =
      doc.nodes.length > 2000 ? 300 : doc.nodes.length > 500 ? 100 : 0;
    const run = () => {
      if (!active) return;
      saveLatest(doc)
        .then(() => {
          if (active) setSavedDocument(doc);
        })
        .catch((err) => {
          if (active)
            setError(
              err instanceof Error ? err.message : "保存失败，请下载当前设计",
            );
        });
    };
    const timer = delay ? window.setTimeout(run, delay) : undefined;
    if (!delay) run();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [history.present, protectCache, saved, saveLatest]);
  useEffect(() => {
    if (saved || protectCache) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [saved, protectCache]);
  // Update the ref synchronously: rapid keyboard/pointer events must never commit against stale React state.
  const replaceHistory = useCallback((next: History) => {
    historyRef.current = next;
    setHistory(next);
    setPreview(null);
  }, []);
  const apply = useCallback(
    (operations: Operation[], baseRevision?: number) => {
      if (!operations.length) return;
      const current = historyRef.current;
      const next = commitEditorOperations(
        current.present,
        operations,
        baseRevision ?? current.present.revision,
      );
      replaceHistory(commit(current, next));
      setError("");
    },
    [replaceHistory],
  );
  const attempt = useCallback((work: () => void) => {
    try {
      work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const undo = useCallback(
    () => replaceHistory(travel(historyRef.current, "undo")),
    [replaceHistory],
  );
  const redo = useCallback(
    () => replaceHistory(travel(historyRef.current, "redo")),
    [replaceHistory],
  );
  const importDocument = useCallback(
    (input: unknown) => {
      const document = parseDocument(input);
      const current = historyRef.current;
      replaceHistory(
        commit(current, {
          ...document,
          revision: current.present.revision + 1,
        }),
      );
      setProtectCache(false);
      setError("");
    },
    [replaceHistory],
  );
  return {
    doc: preview ?? history.present,
    committed: history.present,
    historyRef,
    preview,
    setPreview,
    apply,
    attempt,
    undo,
    redo,
    importDocument,
    async recoverPrevious() {
      try {
        const previous = await repository.recovery();
        if (!previous) throw new Error("本机没有更早的保存版本");
        importDocument(previous);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    async downloadBackup() {
      try {
        const backup = await repository.backup();
        if (!backup) throw new Error("本机还没有存储备份");
        download(
          "forma-storage-backup.json",
          typeof backup === "string" || backup instanceof Blob
            ? backup
            : JSON.stringify(backup),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    switchPage(id: string) {
      const current = historyRef.current;
      const next = openPage(current.present, id);
      if (next !== current.present)
        replaceHistory({
          ...current,
          present: { ...next, revision: current.present.revision + 1 },
        });
    },
    error,
    setError,
    saved,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
export type DocumentController = ReturnType<typeof useDocument>;
