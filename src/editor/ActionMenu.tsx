import { Fragment, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { editActions, isEditActionEnabled, type ActionId } from "./actions";
import type { EditorController } from "./useEditor";
import { useModalDialog } from "./useModalDialog";

export function CommandPalette({
  editor: e,
  close,
}: {
  editor: EditorController;
  close(): void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useModalDialog(true, close);
  const inputRef = useRef<HTMLInputElement>(null);

  const [recent] = useState<ActionId[]>(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem("forma.recent-actions") || "[]",
      );
      return Array.isArray(stored)
        ? stored
            .filter((id) => editActions.some((action) => action.id === id))
            .slice(0, 5)
        : [];
    } catch {
      return [];
    }
  });
  const term = query.trim().toLowerCase();
  const matches = (text: string) => {
    if (text.includes(term)) return true;
    if (term.length < 2) return false;
    let offset = 0;
    for (const char of text)
      if (char === term[offset] && ++offset === term.length) return true;
    return false;
  };
  const category = (action: (typeof editActions)[number]) =>
    !term && recent.includes(action.id) ? "最近使用" : action.category;
  const groups = [
    "最近使用",
    "编辑",
    "组织与组件",
    "排列与对齐",
    "矢量与路径",
    "视图",
  ];
  const items = editActions
    .filter(
      (a) =>
        !term ||
        [a.label, ...a.keywords.split(" "), a.shortcut || ""].some((s) =>
          matches(s.toLowerCase()),
        ),
    )
    .sort(
      (a, b) =>
        groups.indexOf(category(a)) - groups.indexOf(category(b)) ||
        (category(a) === "最近使用"
          ? recent.indexOf(a.id) - recent.indexOf(b.id)
          : 0),
    );

  const enabledIds = new Set(
    items
      .filter((item) => isEditActionEnabled(item.id, e.actionEligibility))
      .map((item) => item.id),
  );
  const disabled = (item: (typeof editActions)[number]) =>
    !enabledIds.has(item.id);

  const enabledIndices = items
    .map((item, idx) => (!disabled(item) ? idx : -1))
    .filter((idx) => idx >= 0);

  useEffect(() => {
    setActiveIndex(enabledIndices[0] ?? -1);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (id: ActionId) => {
    try {
      localStorage.setItem(
        "forma.recent-actions",
        JSON.stringify(
          [id, ...recent.filter((entry) => entry !== id)].slice(0, 5),
        ),
      );
    } catch {
      /* Storage is optional. */
    }
    e.perform(id);
    close();
  };

  const stepActive = (delta: 1 | -1) => {
    if (!enabledIndices.length) return;
    const curPos = enabledIndices.indexOf(activeIndex);
    const nextPos =
      curPos < 0
        ? delta > 0
          ? 0
          : enabledIndices.length - 1
        : (curPos + delta + enabledIndices.length) % enabledIndices.length;
    const next = enabledIndices[nextPos];
    setActiveIndex(next);
    document
      .getElementById("cmd-" + items[next].id)
      ?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            (event.key.toLowerCase() === "k" || event.key === "/")
          ) {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            stepActive(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            stepActive(-1);
          }
        }}
        aria-modal="true"
        role="dialog"
        aria-label="搜索操作"
        className="action-menu command-palette"
      >
        <div className="palette-search-wrap">
          <Search size={14} style={{ color: "var(--text-muted)" }} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-autocomplete="list"
            aria-label="搜索命令"
            aria-activedescendant={
              activeIndex >= 0 && items[activeIndex]
                ? `cmd-${items[activeIndex].id}`
                : undefined
            }
            value={query}
            placeholder="搜索操作（支持中英文，例如：复制、group、align）…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              event.preventDefault();
              const chosen =
                activeIndex >= 0 &&
                items[activeIndex] &&
                !disabled(items[activeIndex])
                  ? items[activeIndex]
                  : items.find((item) => !disabled(item));
              if (chosen) run(chosen.id);
            }}
          />
          {query && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="清空搜索"
              data-tip="清空搜索"
              onClick={() => setQuery("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div
          id="command-results"
          className="menu-items"
          role="listbox"
          aria-label="操作结果"
        >
          {!items.length && (
            <p className="compact-empty" role="status">
              无匹配操作
            </p>
          )}
          {items.map((item, idx) => {
            const isDisabled = disabled(item);
            const highlighted = idx === activeIndex && !isDisabled;
            return (
              <Fragment key={item.id}>
                {(!idx || category(items[idx - 1]) !== category(item)) && (
                  <div role="presentation" className="command-category">
                    {category(item)}
                  </div>
                )}
                <button
                  id={`cmd-${item.id}`}
                  role="option"
                  aria-selected={highlighted}
                  tabIndex={-1}
                  className={highlighted ? "is-highlighted" : ""}
                  disabled={isDisabled}
                  onMouseEnter={() => {
                    if (!isDisabled) setActiveIndex(idx);
                  }}
                  onClick={() => run(item.id)}
                >
                  <span>{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const shortcutGroups: Record<string, [string, string][]> = {
  画布与视图: [
    ["切换工具栏、图层、画布和属性栏", "F6 / ⇧ F6"],
    ["显隐界面侧栏", "⌘ \\"],
    ["平移画布", "空格 + 拖动 / H"],
    ["鼠标位置缩放", "⌘ + 滚轮"],
    ["放大 / 缩小画布", "+ / -"],
    ["缩放至 100%", "⌘ 0 / ⇧ 0"],
    ["缩放至全部内容", "⇧ 1"],
    ["缩放至选区", "⇧ 2"],
    ["显示或隐藏标尺", "⇧ R"],
    ["显示或隐藏布局参考网格", "⌃ G"],
    ["切换像素网格", "⌘ '"],
    ["切换轮廓线框视图", "⌘ Y / ⇧ O"],
    ["显示或隐藏画布评论", "⇧ C"],
    ["切换设计 / 原型面板", "⇧ E"],
    ["切换开发检查模式 (Dev Mode)", "⇧ D"],
    ["画布内联 AI 对话", "⌘ ↵"],
    ["批量导出资源与切片", "⇧ ⌘ E"],
    ["切换图层 / 资源面板", "⌥ 1 / ⌥ 2"],
    ["搜索命令", "⌘ K / ⌘ /"],
  ],
  工具与绘制: [
    ["选择与移动工具", "V"],
    ["比例缩放工具", "K"],
    ["抓手平移工具", "H"],
    ["画板 / 分区 / 切片工具", "F / ⇧ S / S"],
    ["矩形 / 椭圆 / 直线", "R / O / L"],
    ["钢笔 / 铅笔工具", "P / ⇧ P"],
    ["文本工具", "T"],
    ["评论图钉工具", "C"],
    ["插入画板 / 文本", "F → Enter / T → Enter"],
    ["等比 / 中心调整", "⇧ / ⌥ + 把手"],
  ],
  编辑与选择: [
    ["撤销 / 重做", "⌘ Z / ⇧ ⌘ Z"],
    ["剪切 / 复制 / 粘贴 / 原位粘贴", "⌘ X / ⌘ C / ⌘ V / ⇧ ⌘ V"],
    ["创建副本 / 拖动副本", "⌘ D / ⌥ + 拖动"],
    ["删除", "⌫"],
    ["穿透选择子层", "⌘ + 点击"],
    ["选择匹配图层", "⌥ ⌘ A"],
    ["增减选区", "⇧ + 点击"],
    ["进入子层 / 编辑文本", "Enter / 双击"],
    ["返回父层", "⇧ Enter / Esc"],
    ["相邻图层", "Tab / ⇧ Tab"],
    ["移动图层 1px / 10px", "方向键 / ⇧ + 方向键"],
    ["水平 / 垂直翻转", "⇧ H / ⇧ V"],
    ["重命名图层", "⌘ R"],
    ["锁定 / 隐藏图层", "⇧ ⌘ L / ⇧ ⌘ H"],
    ["复制 / 粘贴样式", "⌥ ⌘ C / ⌥ ⌘ V"],
  ],
  布局与组件: [
    ["编组 / 取消编组", "⌘ G / ⇧ ⌘ G"],
    ["包裹为画板 / 分区", "⌥ ⌘ G / ⇧ S"],
    ["添加自动布局", "⇧ A"],
    ["创建主组件", "⌥ ⌘ K"],
    ["分离组件实例", "⌥ ⌘ B"],
    ["用作蒙版", "⌃ ⌘ M"],
    ["拼合布尔图形", "⌘ E"],
    ["置于顶层 / 底层", "⌘ ] / ⌘ ["],
    ["上移 / 下移一层", "] / ["],
  ],
};

export function ShortcutHelp({ close }: { close(): void }) {
  const ref = useModalDialog(true, close, false);
  const [tab, setTab] = useState<string>("全部");
  const categories = ["全部", ...Object.keys(shortcutGroups)];
  const rows =
    tab === "全部"
      ? Object.values(shortcutGroups).flat()
      : (shortcutGroups[tab] ?? []);

  return (
    <div
      ref={ref}
      className="shortcut-drawer"
      aria-modal="false"
      role="dialog"
      aria-label="快捷键"
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key === "?") {
          ev.preventDefault();
          close();
        }
      }}
    >
      <div className="shortcut-drawer-head">
        <strong style={{ fontSize: 12 }}>常用快捷键</strong>
        <div className="shortcut-drawer-tabs">
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              className={tab === name ? "active" : ""}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: "var(--text-muted)",
          }}
        >
          macOS 使用 ⌘，Windows / Linux 使用 Ctrl
        </span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭快捷键帮助"
          data-tip="关闭"
          data-tip-kbd="Esc"
          onClick={close}
        >
          <X size={15} />
        </button>
      </div>
      <div className="shortcut-drawer-grid">
        {rows.map(([label, key]) => (
          <div className="shortcut-drawer-row" key={label}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
