import { Monitor, Smartphone, Sparkles, Upload } from "lucide-react";
import { WELCOME_FRAME_PRESETS } from "./ux-copy";

export interface CanvasWelcomeOverlayProps {
  visible: boolean;
  onCreateFrame(label: string, width: number, height: number): void;
  onOpenAi(): void;
  onImportFile(): void;
  onDismiss(): void;
}

export function CanvasWelcomeOverlay({
  visible,
  onCreateFrame,
  onOpenAi,
  onImportFile,
  onDismiss,
}: CanvasWelcomeOverlayProps) {
  if (!visible) return null;
  const { mobile, desktop } = WELCOME_FRAME_PRESETS;
  const actions = [
    {
      title: "移动端画板",
      detail: `${mobile.w} × ${mobile.h} · ${mobile.label}`,
      icon: Smartphone,
      activate: () => onCreateFrame(mobile.label, mobile.w, mobile.h),
    },
    {
      title: "桌面端画板",
      detail: `${desktop.w} × ${desktop.h} · Web`,
      icon: Monitor,
      activate: () => onCreateFrame(desktop.label, desktop.w, desktop.h),
    },
    {
      title: "用 Forma AI 起稿",
      detail: "⌘↵ 对话生成可编辑画板",
      icon: Sparkles,
      activate: onOpenAi,
    },
    {
      title: "导入设计文件",
      detail: ".fig / .sketch / .forma",
      icon: Upload,
      activate: onImportFile,
    },
  ];
  return (
    <section
      className="canvas-welcome-overlay"
      role="region"
      aria-label="快速开始"
    >
      <div
        className="canvas-welcome-card"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="canvas-welcome-head">
          <Sparkles size={18} aria-hidden="true" />
          <div>
            <h2>开始你的新设计</h2>
            <p>新建画板直接绘制，导入现有设计稿，或让 Forma AI 帮你起稿</p>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="收起引导"
            data-tip="收起引导"
            data-tip-side="bottom"
            onClick={onDismiss}
          >
            ×
          </button>
        </header>
        <div className="canvas-welcome-grid">
          {actions.map(({ title, detail, icon: Icon, activate }) => (
            <button
              type="button"
              className="canvas-welcome-action"
              key={title}
              onClick={activate}
            >
              <Icon size={18} aria-hidden="true" />
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </div>
        <footer className="canvas-welcome-samples">
          <span>探索内置示例：</span>
          <a href="?example=aura-showcase" target="_blank" rel="noreferrer">
            SaaS 工作台样例 ↗
          </a>
          <a
            href="?example=mobile-studio&edition=atlas&page=atlas&node=atlas-tablet-root"
            target="_blank"
            rel="noreferrer"
          >
            移动设计研究室 ↗
          </a>
        </footer>
      </div>
    </section>
  );
}
