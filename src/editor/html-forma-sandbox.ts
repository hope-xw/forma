import {
  compileRenderedDomToForma,
  computeMatrixArtboardPlacements,
  mergeHtmlArtboardResults,
  resolveHtmlComponentSlot,
  type HtmlArtboardSpec,
  hydrateIconsInDom,
  sanitizeDesignHtml,
  type HtmlDesignDraft,
  type HtmlToFormaResult,
} from "../agent/html-to-forma";
import type { DesignDocument } from "../domain/document";
import { maxLayerDimension } from "../domain/document-limits";
import { exportNodeAsRaster } from "../infrastructure/static-export";

const spacing = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24, 32,
];
const utilities = [
  "*,::before,::after{box-sizing:border-box;animation:none!important;transition:none!important} html,body{margin:0;padding:0} body{font:16px/1.5 system-ui,sans-serif;color:#111827} :where(h1,h2,h3,h4,h5,h6,p,figure,ul,ol){margin:0} :where(button,input){font:inherit;color:inherit;padding:0;border:0;background:transparent} img,svg{vertical-align:middle}",
  ".flex{display:flex}.inline-flex{display:inline-flex}.flex-row{flex-direction:row}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.flex-1{flex:1 1 0%}.grow{flex-grow:1}.shrink-0{flex-shrink:0}.grid{display:grid}.block{display:block}.hidden{display:none}",
  ".items-start{align-items:flex-start}.items-center{align-items:center}.items-end{align-items:flex-end}.items-stretch{align-items:stretch}.justify-start{justify-content:flex-start}.justify-center{justify-content:center}.justify-end{justify-content:flex-end}.justify-between{justify-content:space-between}.place-items-center{place-items:center}",
  ".relative{position:relative}.absolute{position:absolute}.fixed{position:fixed}.inset-0{inset:0}.overflow-hidden{overflow:hidden}.w-full{width:100%}.h-full{height:100%}.min-w-0{min-width:0}.object-cover{object-fit:cover}.object-contain{object-fit:contain}",
  ".rounded{border-radius:4px}.rounded-sm{border-radius:2px}.rounded-md{border-radius:6px}.rounded-lg{border-radius:8px}.rounded-xl{border-radius:12px}.rounded-2xl{border-radius:16px}.rounded-3xl{border-radius:24px}.rounded-full{border-radius:9999px}",
  ".backdrop-blur-sm{backdrop-filter:blur(4px)}.backdrop-blur{backdrop-filter:blur(8px)}.backdrop-blur-md{backdrop-filter:blur(12px)}.backdrop-blur-lg{backdrop-filter:blur(16px)}.backdrop-blur-xl{backdrop-filter:blur(24px)}",
  ".font-medium{font-weight:500}.font-semibold{font-weight:600}.font-bold{font-weight:700}.text-center{text-align:center}.text-white{color:white}.bg-white{background:white}.bg-black{background:black}",
  ...Array.from(
    { length: 12 },
    (_, i) =>
      `.grid-cols-${i + 1}{grid-template-columns:repeat(${i + 1},minmax(0,1fr))}`,
  ),
  ...spacing.map((n) => {
    const v = n * 4 + "px",
      k = String(n).replace(".", "\\.");
    return `.gap-${k}{gap:${v}}.gap-x-${k}{column-gap:${v}}.gap-y-${k}{row-gap:${v}}.p-${k}{padding:${v}}.px-${k}{padding-left:${v};padding-right:${v}}.py-${k}{padding-top:${v};padding-bottom:${v}}`;
  }),
].join("\n");

function dimension(value: number) {
  if (!Number.isFinite(value)) throw Error("画板尺寸必须是有限数值");
  return Math.min(maxLayerDimension, Math.max(0, value));
}

async function waitForAssets(doc: Document, root: HTMLElement) {
  // Start layout before reading fonts.ready so newly used faces participate.
  root.getBoundingClientRect();
  const pending: Promise<unknown>[] = [];
  if (doc.fonts) pending.push(doc.fonts.ready);
  for (const img of root.querySelectorAll("img")) {
    img.loading = "eager";
    if (typeof img.decode === "function") pending.push(img.decode());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const hydratedDocuments = new WeakSet<Document>();
export function hydrateComponentPlaceholdersInDom(
  rootEl: Element,
  baseDocument: DesignDocument,
  fallbackLibraryId?: string,
) {
  const selector = "[data-forma-component]";
  const doc = rootEl.ownerDocument;
  let count = 0;
  for (const el of [
    ...(rootEl.matches(selector) ? [rootEl] : []),
    ...rootEl.querySelectorAll(selector),
  ]) {
    const slot = resolveHtmlComponentSlot(baseDocument, el, fallbackLibraryId);
    const source = slot?.variant.nodes.find((n) => n.parentId === null);
    if (!source) continue;
    if (!hydratedDocuments.has(doc)) {
      // Defaults have lower cascade priority than author CSS, including class-based dimensions.
      const defaults = doc.createElement("style");
      defaults.textContent =
        "@layer forma-slot-defaults { :where([data-forma-component]) { width:var(--forma-slot-width,auto);height:var(--forma-slot-height,auto) } }";
      doc.head.prepend(defaults);
      hydratedDocuments.add(doc);
    }
    const style = (el as HTMLElement).style;
    const view = doc.defaultView!;
    const grow = Number(view.getComputedStyle(el).flexGrow) > 0;
    style.boxSizing = "border-box";
    style.setProperty(
      "--forma-slot-width",
      grow ? "auto" : source.style.width + "px",
    );
    // This is the preferred height. Flex can distribute space on top of it,
    // and an author height (including a smaller one) always wins the cascade.
    style.setProperty("--forma-slot-height", source.style.height + "px");
    count++;
  }
  return count;
}

type SandboxOptions = {
  baseDocument: DesignDocument;
  iconResolver?: Parameters<typeof hydrateIconsInDom>[1];
  selectionParentId?: string | null;
  viewportCenter?: { x: number; y: number };
  activeLibraryId?: string;
  snapLibraryTokens?: boolean;
};

export async function compileHtmlDraftInBrowser(
  draft: HtmlDesignDraft,
  options: SandboxOptions,
): Promise<HtmlToFormaResult> {
  const settings = {
    ...options,
    activeLibraryId: draft.targetLibraryId ?? options.activeLibraryId,
    snapLibraryTokens: draft.snapLibraryTokens ?? options.snapLibraryTokens,
  };
  if (!draft.artboards?.length)
    return compileBoard(draft, draft.images, settings);
  const boards = draft.artboards.map((b) => ({
    ...b,
    width: dimension(b.width),
    height: dimension(b.height),
  }));
  const placements = computeMatrixArtboardPlacements(
    options.baseDocument,
    boards,
    options.viewportCenter,
  );
  const workingDoc = {
    ...options.baseDocument,
    libraries: { ...options.baseDocument.libraries },
    images: { ...options.baseDocument.images },
  };
  const results: HtmlToFormaResult[] = [];
  for (const [i, board] of boards.entries()) {
    const result = await compileBoard(
      { ...board, placement: placements[i] },
      draft.images,
      { ...settings, baseDocument: workingDoc },
    );
    results.push(result);
    // Carry only shared resources across sandboxes. The single transaction allocates board-local IDs at merge.
    for (const op of result.transaction.operations) {
      if (op.type === "putImage") workingDoc.images[op.id] = op.image;
      else if (op.type === "setDesignSystem")
        workingDoc.designSystem = op.system;
      else if (op.type === "putLibrary")
        workingDoc.libraries[op.library.id] = op.library;
    }
  }
  return mergeHtmlArtboardResults(options.baseDocument, results);
}

async function compileBoard(
  draft: HtmlArtboardSpec,
  images: HtmlDesignDraft["images"],
  options: SandboxOptions,
): Promise<HtmlToFormaResult> {
  const clean = sanitizeDesignHtml(draft.html, draft.css);
  const width = dimension(draft.width),
    height = dimension(draft.height);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-200000px;top:0;width:${width}px;height:${height}px;border:0;opacity:0;pointer-events:none`;
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    if (!doc) throw Error("无法创建 HTML 排版沙盒");
    // Only this constant scaffold goes through the document parser. Draft
    // CSS is assigned as text and HTML is confined to the artboard fragment.
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"></head><body></body></html>`,
    );
    doc.close();
    const style = doc.createElement("style");
    style.textContent = utilities + "\n" + clean.css;
    doc.head.appendChild(style);
    const root = doc.createElement("div");
    root.id = "forma-html-root";
    root.style.cssText = `position:relative;width:${width}px;height:${height}px`;
    root.innerHTML = clean.html;
    doc.body.appendChild(root);
    for (const img of root.querySelectorAll("img[data-forma-asset-id]")) {
      const id = img.getAttribute("data-forma-asset-id")!;
      const asset = options.baseDocument.images?.[id] ?? images?.[id];
      if (asset) (img as HTMLImageElement).src = asset.data;
    }
    if (options.iconResolver) hydrateIconsInDom(root, options.iconResolver);
    hydrateComponentPlaceholdersInDom(
      root,
      options.baseDocument,
      options.activeLibraryId,
    );
    await waitForAssets(doc, root);
    return compileRenderedDomToForma(root, {
      baseDocument: options.baseDocument,
      selectionParentId: options.selectionParentId,
      name: draft.name,
      width,
      height,
      placement: draft.placement,
      images,
      activeLibraryId: options.activeLibraryId,
      snapLibraryTokens: options.snapLibraryTokens,
    });
  } finally {
    frame.remove();
  }
}

export async function captureFormaArtboardPng(
  doc: DesignDocument,
  rootId: string,
  scale = 1,
): Promise<string> {
  if (!Number.isFinite(scale) || scale <= 0)
    throw Error("PNG 导出倍率必须大于零");
  const blob = await exportNodeAsRaster(doc, rootId, { format: "png", scale });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? Error("无法读取画板 PNG"));
    reader.readAsDataURL(blob);
  });
}
