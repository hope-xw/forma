import { useCallback, useEffect, useRef, useState } from "react";
import { commitEditorOperations } from "../application/geometry-preview";
import { commit, travel, type History } from "../application/history";
import type { Operation } from "../domain/commands";
import { parseDocument, type DesignDocument } from "../domain/document";
import { createStarter } from "../domain/seed";
import { openPage } from "../domain/pages";
import { FileLifetimeMismatchError } from "../infrastructure/project-memory-store";
import {
  BrowserDocumentRepository,
  download,
  type DocumentRepository,
} from "../infrastructure/storage";
const defaultRepository = new BrowserDocumentRepository();
export interface EditorFileOptions {
  active?: boolean;
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
  const branchIdsRef = useRef(new WeakMap<DesignDocument, number>());
  if (!branchIdsRef.current.has(initial.document))
    branchIdsRef.current.set(initial.document, 0);
  const nextBranchIdRef = useRef(1);
  const lastSavedBranchRef = useRef(0);
  const branchOf = useCallback(
    (doc: DesignDocument) => branchIdsRef.current.get(doc) ?? 0,
    [],
  );
  const [error, setError] = useState(initial.error);
  const [savedDocument, setSavedDocument] = useState<DesignDocument | null>(
    initialSaved ? (initialDocument ?? null) : null,
  );
  const savedDocumentRef = useRef<DesignDocument | null>(savedDocument);
  savedDocumentRef.current = savedDocument;
  const [protectCache, setProtectCache] = useState(!!initial.error);
  const protectCacheRef = useRef(protectCache);
  protectCacheRef.current = protectCache;
  const recoveryInProgress = useRef(false);
  const [preview, setPreview] = useState<DesignDocument | null>(null);
  const pending = useRef<{
    doc: DesignDocument;
    promise: Promise<void>;
  } | null>(null);
  // Autosaves queued behind an import share its marker until one write succeeds.
  const pendingReplacementDocRef = useRef<{ document: DesignDocument | null }>({
    document: null,
  });
  const saveLatest = useCallback(
    (doc: DesignDocument) => {
      if (pending.current?.doc === doc) return pending.current.promise;
      const replacement = pendingReplacementDocRef.current;
      const write = async () => {
        // A failed import save leaves the replacement flag on its next autosave.
        if (replacement.document) {
          await repository.save(doc, { replacedDocument: true });
          replacement.document = null;
        } else await repository.save(doc);
        lastSavedBranchRef.current = branchOf(doc);
      };
      const previous = pending.current;
      const promise = (
        previous ? previous.promise.then(write, write) : write()
      ).catch((error) => {
        if (pending.current?.promise === promise) pending.current = null;
        throw error;
      });
      pending.current = { doc, promise };
      return promise;
    },
    [repository, branchOf],
  );
  const hasUncommittedReplacementBoundary = useCallback(
    () =>
      branchOf(historyRef.current.present) !== lastSavedBranchRef.current ||
      pendingReplacementDocRef.current.document !== null,
    [branchOf],
  );
  const getLifetimeToken = useCallback(async () => {
    const active = pending.current;
    if (active) {
      try {
        await active.promise;
      } catch {
        /* Keep the session's last valid token if the save failed. */
      }
    }
    return repository.getLifetimeToken?.();
  }, [repository]);
  const getDocumentEpoch = useCallback(async () => {
    const active = pending.current;
    if (active) {
      try {
        await active.promise;
      } catch {
        /* A failed ordinary edit can still use its branch's saved epoch. */
      }
    }
    if (hasUncommittedReplacementBoundary())
      throw new FileLifetimeMismatchError(
        "当前文件已在其他标签页更新，请重新打开文件",
      );
    return repository.getDocumentEpoch?.();
  }, [repository, hasUncommittedReplacementBoundary]);
  const saved = !protectCache && savedDocument === history.present;
  useEffect(() => {
    if (protectCache || saved) return;
    let active = true;
    const doc = history.present;
    const delay =
      doc.nodes.length > 2000 ? 300 : doc.nodes.length > 500 ? 100 : 0;
    const run = () => {
      if (!active || historyRef.current.present !== doc) return;
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
    return () => {
      if (
        !protectCacheRef.current &&
        historyRef.current.present !== savedDocumentRef.current
      ) {
        void saveLatest(historyRef.current.present).catch(() => {});
      }
    };
  }, [saveLatest]);
  const flushSave = useCallback(async () => {
    if (protectCacheRef.current) return;
    if (historyRef.current.present !== savedDocumentRef.current) {
      await saveLatest(historyRef.current.present);
      setSavedDocument(historyRef.current.present);
    } else if (pending.current) {
      await pending.current.promise;
    }
  }, [saveLatest]);
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
      branchIdsRef.current.set(next, branchOf(current.present));
      replaceHistory(commit(current, next));
      setError("");
    },
    [branchOf, replaceHistory],
  );
  const attempt = useCallback((work: () => void) => {
    try {
      work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const saveReplacement = useCallback(
    (doc: DesignDocument) => {
      pendingReplacementDocRef.current = { document: doc };
      void saveLatest(doc).catch((err) => {
        if (historyRef.current.present === doc)
          setError(err instanceof Error ? err.message : String(err));
      });
    },
    [saveLatest],
  );
  const travelHistory = useCallback(
    (direction: "undo" | "redo") => {
      const current = historyRef.current;
      const traveled = travel(current, direction);
      if (traveled.present === current.present) return;
      // travel clones the history target to give it a new revision.
      const target = (direction === "undo" ? current.past : current.future).at(
        -1,
      )!;
      const branch = branchOf(target);
      branchIdsRef.current.set(traveled.present, branch);
      replaceHistory(traveled);
      if (branch !== branchOf(current.present) && !protectCache)
        saveReplacement(traveled.present);
    },
    [branchOf, protectCache, replaceHistory, saveReplacement],
  );
  const undo = useCallback(() => travelHistory("undo"), [travelHistory]);
  const redo = useCallback(() => travelHistory("redo"), [travelHistory]);
  const importDocument = useCallback(
    (input: unknown, options?: { replacedDocument?: boolean }) => {
      const document = parseDocument(input);
      const current = historyRef.current;
      const next = { ...document, revision: current.present.revision + 1 };
      branchIdsRef.current.set(
        next,
        options?.replacedDocument
          ? nextBranchIdRef.current++
          : branchOf(current.present),
      );
      replaceHistory(commit(current, next));
      setError("");
      if (options?.replacedDocument && !protectCache) {
        // Queue every explicit replacement, even if React batches another edit
        // or a second import before the autosave effect runs.
        saveReplacement(next);
      }
    },
    [branchOf, replaceHistory, protectCache, saveReplacement],
  );
  return {
    doc: preview ?? history.present,
    committed: history.present,
    historyRef,
    getLifetimeToken,
    getDocumentEpoch,
    getCurrentDocumentEpoch: () =>
      hasUncommittedReplacementBoundary()
        ? undefined
        : repository.getDocumentEpoch?.(),
    getCurrentLifetimeToken: () => repository.getLifetimeToken?.(),
    protectCache,
    preview,
    setPreview,
    apply,
    attempt,
    undo,
    redo,
    importDocument,
    async recoverPrevious() {
      if (recoveryInProgress.current) return;
      recoveryInProgress.current = true;
      try {
        const previous = await repository.recovery();
        if (!previous) throw new Error("本机没有更早的保存版本");
        if (protectCache) {
          // The failed-load placeholder does not belong in the restored history.
          branchIdsRef.current.set(previous, nextBranchIdRef.current++);
          replaceHistory({ present: previous, past: [], future: [] });
          pendingReplacementDocRef.current = { document: previous };
          await saveLatest(previous);
          setSavedDocument(previous);
          setProtectCache(false);
          setError("");
        } else {
          importDocument(previous, { replacedDocument: true });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        recoveryInProgress.current = false;
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
      const page = openPage(current.present, id);
      if (page !== current.present) {
        const next = { ...page, revision: current.present.revision + 1 };
        branchIdsRef.current.set(next, branchOf(current.present));
        replaceHistory({ ...current, present: next });
      }
    },
    error,
    setError,
    saved,
    flushSave,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
export type DocumentController = ReturnType<typeof useDocument>;
