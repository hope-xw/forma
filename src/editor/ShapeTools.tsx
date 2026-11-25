import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  Square,
  Circle,
  Slash,
  Pentagon,
  Star,
  ChevronUp,
  Check,
  Frame,
  LayoutPanelTop,
  Scissors,
  PenTool,
  Pencil,
  MousePointer2,
  Scaling,
  Hand,
} from "lucide-react";
import type { ShapeTool } from "../domain/shape-tools";
import type { Tool } from "./useEditor";

export type ExtendedTool =
  Tool | "section" | "slice" | "scale" | "pencil" | "comment";
const shapes = {
  rectangle: {
    label: "矩形",
    key: "R",
    desc: "拖拽绘制矩形，按住 Shift 绘制正方形",
    icon: Square,
  },
  ellipse: {
    label: "椭圆",
    key: "O",
    desc: "拖拽绘制椭圆，按住 Shift 绘制正圆",
    icon: Circle,
  },
  line: {
    label: "直线",
    key: "L",
    desc: "拖拽绘制直线，按住 Shift 吸附 45° 角度",
    icon: Slash,
  },
  polygon: {
    label: "多边形",
    key: "",
    desc: "拖拽绘制正多边形，可在右侧调整边数",
    icon: Pentagon,
  },
  star: {
    label: "星形",
    key: "",
    desc: "拖拽绘制星形，可在右侧调整尖角数与内半径",
    icon: Star,
  },
};
export function ShapeTools({
  tool,
  choose,
}: {
  tool: ExtendedTool;
  choose: (id: ShapeTool) => void;
}) {
  const [last, setLast] = useState<ShapeTool>("rectangle");
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  const active = Object.hasOwn(shapes, tool);
  const current = active ? (tool as ShapeTool) : last;
  useEffect(() => {
    if (active) setLast(tool as ShapeTool);
  }, [active, tool]);
  useEffect(() => {
    if (!open) return;
    const outside = (ev: PointerEvent) => {
      if (!group.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    group.current
      ?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      )
      ?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const select = (id: ShapeTool) => {
    setOpen(false);
    setLast(id);
    choose(id);
    const canvas = document.querySelector<HTMLElement>(".editor-canvas");
    if (canvas) canvas.focus();
    else toggle.current?.focus();
  };
  const { icon: Icon, label, key, desc } = shapes[current];
  return (
    <div
      className="shape-tools"
      ref={group}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          setOpen(false);
      }}
    >
      <button
        aria-label={("绘制" + label + " " + key).trim()}
        title={("绘制" + label + " " + key).trim()}
        data-tip={`绘制${label}`}
        data-tip-kbd={key || undefined}
        data-tip-desc={desc}
        data-tip-side="top"
        aria-pressed={active}
        className={`tool-btn ${active ? "selected-tool" : ""}`}
        onClick={() => choose(current)}
      >
        <Icon size={18} />
      </button>
      <button
        ref={toggle}
        className="shape-disclosure"
        aria-label="形状工具"
        title="形状工具"
        data-tip="切换更多形状"
        data-tip-desc="选择矩形、椭圆、直线、多边形或星形绘图工具"
        data-tip-side="top"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ChevronUp size={11} />
      </button>
      {open && (
        <div
          className="shape-menu"
          role="menu"
          aria-label="形状工具"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              setOpen(false);
              toggle.current?.focus();
              return;
            }
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
            );
            const i = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              items[
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? items.length - 1
                    : (i + (e.key === "ArrowUp" ? -1 : 1) + items.length) %
                      items.length
              ].focus();
            }
          }}
        >
          {(Object.keys(shapes) as ShapeTool[]).map((id) => {
            const { icon: Glyph, label, key } = shapes[id];
            return (
              <button
                role="menuitemradio"
                key={id}
                aria-checked={current === id}
                onClick={() => select(id)}
              >
                <span
                  aria-hidden="true"
                  style={{ display: "inline-grid", placeItems: "center" }}
                >
                  {current === id ? <Check size={12} /> : null}
                </span>
                <Glyph size={14} />
                <span>{label}</span>
                {key ? <kbd>{key}</kbd> : <span />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ToolGroupItem<T extends ExtendedTool> {
  id: T;
  label: string;
  ariaLabel: string;
  tip: string;
  key: string;
  desc: string;
  icon: ComponentType<{ size?: number }>;
}

function ToolGroupPicker<T extends ExtendedTool>({
  tool,
  choose,
  items,
  defaultTool,
  menuLabel,
  disclosureTip,
  disclosureDesc,
}: {
  tool: ExtendedTool;
  choose: (id: T) => void;
  items: readonly ToolGroupItem<T>[];
  defaultTool: T;
  menuLabel: string;
  disclosureTip: string;
  disclosureDesc: string;
}) {
  const [last, setLast] = useState<T>(defaultTool);
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const activeItem = items.find((item) => item.id === tool);
  const active = Boolean(activeItem);
  const current =
    activeItem ?? items.find((item) => item.id === last) ?? items[0];

  useEffect(() => {
    if (activeItem) setLast(activeItem.id);
  }, [activeItem]);

  useEffect(() => {
    if (!open) return;
    const outside = (ev: PointerEvent) => {
      if (!group.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    group.current
      ?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      )
      ?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const select = (id: T) => {
    setOpen(false);
    setLast(id);
    choose(id);
    const canvas = document.querySelector<HTMLElement>(".editor-canvas");
    if (canvas) canvas.focus();
    else toggle.current?.focus();
  };

  const Icon = current.icon;
  return (
    <div
      className="shape-tools"
      ref={group}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          setOpen(false);
      }}
    >
      <button
        aria-label={current.ariaLabel}
        title={current.ariaLabel}
        data-tip={current.tip}
        data-tip-kbd={current.key || undefined}
        data-tip-desc={current.desc}
        data-tip-side="top"
        aria-pressed={active}
        className={`tool-btn ${active ? "selected-tool" : ""}`}
        onClick={() => choose(current.id)}
      >
        <Icon size={18} />
      </button>
      <button
        ref={toggle}
        className="shape-disclosure"
        aria-label={menuLabel}
        title={menuLabel}
        data-tip={disclosureTip}
        data-tip-desc={disclosureDesc}
        data-tip-side="top"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ChevronUp size={11} />
      </button>
      {open && (
        <div
          className="shape-menu"
          role="menu"
          aria-label={menuLabel}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              setOpen(false);
              toggle.current?.focus();
              return;
            }
            const btns = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
            );
            const i = btns.indexOf(document.activeElement as HTMLButtonElement);
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              btns[
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? btns.length - 1
                    : (i + (e.key === "ArrowUp" ? -1 : 1) + btns.length) %
                      btns.length
              ]?.focus();
            }
          }}
        >
          {items.map((item) => {
            const Glyph = item.icon;
            return (
              <button
                role="menuitemradio"
                key={item.id}
                aria-checked={current.id === item.id}
                onClick={() => select(item.id)}
              >
                <span
                  aria-hidden="true"
                  style={{ display: "inline-grid", placeItems: "center" }}
                >
                  {current.id === item.id ? <Check size={12} /> : null}
                </span>
                <Glyph size={14} />
                <span>{item.label}</span>
                {item.key ? <kbd>{item.key}</kbd> : <span />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MOVE_TOOLS: readonly ToolGroupItem<"select" | "scale" | "hand">[] = [
  {
    id: "select",
    label: "选择",
    ariaLabel: "选择 V",
    tip: "选择与移动",
    key: "V",
    desc: "选取、框选、移动与缩放图层（⌘ 点击穿透子层，⌥ 拖动复制）",
    icon: MousePointer2,
  },
  {
    id: "scale",
    label: "比例缩放",
    ariaLabel: "比例缩放 K",
    tip: "等比缩放工具",
    key: "K",
    desc: "按比例统一缩放几何尺寸、字号、圆角、描边与间距",
    icon: Scaling,
  },
  {
    id: "hand",
    label: "抓手",
    ariaLabel: "平移 H / 空格",
    tip: "抓手平移画布",
    key: "H",
    desc: "拖动画布视口平移（也可随时按住空格键拖动）",
    icon: Hand,
  },
];

const FRAME_TOOLS: readonly ToolGroupItem<"frame" | "section" | "slice">[] = [
  {
    id: "frame",
    label: "画板",
    ariaLabel: "绘制画板 F",
    tip: "画板工具",
    key: "F",
    desc: "拖拽绘制画板容器，或在右侧直接选择常用设备预设",
    icon: Frame,
  },
  {
    id: "section",
    label: "分区",
    ariaLabel: "绘制分区 ⇧S",
    tip: "画布分区工具",
    key: "⇧S",
    desc: "在画布顶层创建分组分区以组织多个画板与交付状态",
    icon: LayoutPanelTop,
  },
  {
    id: "slice",
    label: "切片",
    ariaLabel: "绘制切片 S",
    tip: "导出切片工具",
    key: "S",
    desc: "绘制可复用的静态资产导出裁切区域",
    icon: Scissors,
  },
];

const PEN_TOOLS: readonly ToolGroupItem<"pen" | "pencil">[] = [
  {
    id: "pen",
    label: "钢笔",
    ariaLabel: "钢笔 P",
    tip: "钢笔矢量工具",
    key: "P",
    desc: "点击或拖拽绘制贝塞尔矢量路径，Enter 完成编辑",
    icon: PenTool,
  },
  {
    id: "pencil",
    label: "铅笔",
    ariaLabel: "铅笔 ⇧P",
    tip: "铅笔自由绘制",
    key: "⇧P",
    desc: "在画布上自由手绘平滑矢量路径",
    icon: Pencil,
  },
];

export function MoveToolGroup({
  tool,
  choose,
}: {
  tool: ExtendedTool;
  choose: (id: "select" | "scale" | "hand") => void;
}) {
  return (
    <ToolGroupPicker
      tool={tool}
      choose={choose}
      items={MOVE_TOOLS}
      defaultTool="select"
      menuLabel="移动与缩放工具"
      disclosureTip="切换移动、缩放与抓手工具"
      disclosureDesc="选择 (V)、等比缩放 (K) 或抓手平移 (H)"
    />
  );
}

export function FrameToolGroup({
  tool,
  choose,
}: {
  tool: ExtendedTool;
  choose: (id: "frame" | "section" | "slice") => void;
}) {
  return (
    <ToolGroupPicker
      tool={tool}
      choose={choose}
      items={FRAME_TOOLS}
      defaultTool="frame"
      menuLabel="画板与分区工具"
      disclosureTip="切换画板、分区与切片工具"
      disclosureDesc="画板 (F)、画布分区 (⇧S) 或导出切片 (S)"
    />
  );
}

export function PenToolGroup({
  tool,
  choose,
}: {
  tool: ExtendedTool;
  choose: (id: "pen" | "pencil") => void;
}) {
  return (
    <ToolGroupPicker
      tool={tool}
      choose={choose}
      items={PEN_TOOLS}
      defaultTool="pen"
      menuLabel="矢量绘图工具"
      disclosureTip="切换钢笔与铅笔工具"
      disclosureDesc="钢笔贝塞尔路径 (P) 或铅笔手绘路径 (⇧P)"
    />
  );
}
