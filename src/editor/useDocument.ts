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
  const [documentSession, setDocumentSession] = useState(1);
  const documentSessionRef = useRef(documentSession);
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
  const [protectCache, setProtectCache] = useState(!!initial.error);
  const protectCacheRef = useRef(protectCache);
  const recoveryInProgress = useRef(false);
  const recoveryPromiseRef = useRef<Promise<DesignDocument | null> | null>(
    null,
  );
  const [preview, publishPreview] = useState<DesignDocument | null>(null);
  const previewRef = useRef<DesignDocument | null>(null);
  const isExternalPreviewRef = useRef(false);
  const [hasExternalPreview, setHasExternalPreview] = useState(false);
  const publish = useCallback(
    (next: DesignDocument | null, external: boolean) => {
      previewRef.current = next;
      isExternalPreviewRef.current = external && next !== null;
      setHasExternalPreview(isExternalPreviewRef.current);
      publishPreview(next);
    },
    [],
  );
  const setPreview = useCallback<typeof publishPreview>(
    (update) => {
      const current = previewRef.current;
      const next = typeof update === "function" ? update(current) : update;
      if (typeof update === "function" && next === current) return;
      publish(next, true);
    },
    [publish],
  );
  const setLocalPreview = useCallback(
    (owned: DesignDocument | null, next: DesignDocument | null) => {
      if (isExternalPreviewRef.current || previewRef.current !== owned)
        return false;
      publish(next, false);
      return true;
    },
    [publish],
  );
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
        savedDocumentRef.current = doc;
        setSavedDocument(doc);
      };
      const previous = pending.current?.promise;
      const recovery = recoveryPromiseRef.current;
      const queued =
        previous || recovery
          ? Promise.allSettled([previous, recovery]).then(write)
          : write();
      const promise = queued.catch((error) => {
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
      saveLatest(doc).catch((err) => {
        if (active && historyRef.current.present === doc)
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
  const replaceHistory = useCallback(
    (next: History, replacedDocument = false) => {
      if (replacedDocument) setDocumentSession(++documentSessionRef.current);
      historyRef.current = next;
      setHistory(next);
      publish(null, false);
    },
    [publish],
  );
  const apply = useCallback(
    (
      operations: Operation[],
      baseRevision?: number,
      options?: { allowOverExternalPreview?: boolean },
    ): false | void => {
      if (
        !operations.length ||
        documentSession !== documentSessionRef.current ||
        (isExternalPreviewRef.current && !options?.allowOverExternalPreview)
      )
        return false;
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
    [branchOf, documentSession, replaceHistory],
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
      if (isExternalPreviewRef.current) return;
      const traveled = travel(current, direction);
      if (traveled.present === current.present) return;
      // travel clones the history target to give it a new revision.
      const target = (direction === "undo" ? current.past : current.future).at(
        -1,
      )!;
      const branch = branchOf(target);
      const replacedDocument = branch !== branchOf(current.present);
      branchIdsRef.current.set(traveled.present, branch);
      replaceHistory(traveled, replacedDocument);
      if (replacedDocument && !protectCache) saveReplacement(traveled.present);
    },
    [branchOf, protectCache, replaceHistory, saveReplacement],
  );
  const undo = useCallback(() => travelHistory("undo"), [travelHistory]);
  const redo = useCallback(() => travelHistory("redo"), [travelHistory]);
  const importDocument = useCallback(
    (input: unknown, options?: { replacedDocument?: boolean }) => {
      if (isExternalPreviewRef.current) return;
      const document = parseDocument(input);
      const current = historyRef.current;
      const next = { ...document, revision: current.present.revision + 1 };
      const replacedDocument =
        options?.replacedDocument || next.id !== current.present.id;
      branchIdsRef.current.set(
        next,
        replacedDocument
          ? nextBranchIdRef.current++
          : branchOf(current.present),
      );
      if (replacedDocument && protectCacheRef.current) {
        protectCacheRef.current = false;
        setProtectCache(false);
        replaceHistory({ present: next, past: [], future: [] }, true);
      } else {
        replaceHistory(commit(current, next), replacedDocument);
      }
      setError("");
      if (replacedDocument) {
        // Queue every explicit replacement, even if React batches another edit
        // or a second import before the autosave effect runs.
        saveReplacement(next);
      }
    },
    [branchOf, replaceHistory, saveReplacement],
  );
  return {
    doc: preview ?? history.present,
    documentSession,
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
    previewRef,
    isExternalPreviewRef,
    hasExternalPreview,
    setLocalPreview,
    setPreview,
    apply,
    attempt,
    undo,
    redo,
    importDocument,
    async recoverPrevious() {
      if (recoveryInProgress.current) return;
      let recoverySession = documentSessionRef.current;
      recoveryInProgress.current = true;
      try {
        // Only the read owns this barrier. Its continuation may itself enqueue a save.
        const read = () => repository.recovery();
        const previousWrite = pending.current?.promise;
        const reading = previousWrite ? previousWrite.then(read, read) : read();
        recoveryPromiseRef.current = reading;
        const previous = await reading;
        if (
          documentSessionRef.current !== recoverySession ||
          isExternalPreviewRef.current
        )
          return;
        if (!previous) throw new Error("本机没有更早的保存版本");
        if (protectCacheRef.current) {
          // The failed-load placeholder does not belong in the restored history.
          branchIdsRef.current.set(previous, nextBranchIdRef.current++);
          replaceHistory({ present: previous, past: [], future: [] }, true);
          recoverySession = documentSessionRef.current;
          pendingReplacementDocRef.current = { document: previous };
          await saveLatest(previous);
          if (documentSessionRef.current !== recoverySession) return;
          protectCacheRef.current = false;
          setProtectCache(false);
          setError("");
        } else {
          importDocument(previous, { replacedDocument: true });
        }
      } catch (err) {
        if (documentSessionRef.current === recoverySession)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        recoveryInProgress.current = false;
        recoveryPromiseRef.current = null;
        const latest = historyRef.current.present;
        if (!protectCacheRef.current && savedDocumentRef.current !== latest) {
          try {
            await saveLatest(latest);
          } catch (err) {
            if (historyRef.current.present === latest)
              setError(err instanceof Error ? err.message : String(err));
          }
        }
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
      if (isExternalPreviewRef.current) return;
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
