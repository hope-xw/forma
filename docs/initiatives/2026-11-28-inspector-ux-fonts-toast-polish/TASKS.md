# Forma 右侧属性面板治理、系统字体转轮廓与 UI3 轻提示任务清单（v0.18.0）

- **课题状态**：已实施并验收（随 `v0.18.0` 发布）
- **最后更新**：2026-11-28

---

## 阶段一：全量只读走查与课题立项
- [x] 复现用户反馈的 3 项问题并验证 macOS `PingFang.ttc` 经 `harfbuzzjs` 真实提取「让好设计，发生。」矢量路径（0 缺失字形）
- [x] 对右侧属性面板 20 个组件、304 处原生控件声明完成独立只读深查，输出 6 P0 / 15 P1 / 5 P2 全量台账
- [x] 创建课题 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记 `docs/initiatives/README.md`

---

## 阶段二：Wave 1 三路零冲突并行 Codex CLI 施工
- [x] **Track 1（系统字体与全格式转轮廓）**：`electron/system-fonts.mjs`、`electron/main.mjs`、`electron/preload.cjs`、`vite.config.ts`、`src/vite-env.d.ts`、`src/infrastructure/font-import.ts`（含 TTF/OTF/TTC/OTC/WOFF1 与按需懒加载 WOFF2）、`src/infrastructure/text-outline.ts`、`src/editor/FontAssets.tsx`、`tests/system-fonts-and-outline.test.ts`
- [x] **Track 2（视口自适应弹层 + UI3 ToastHost + 右栏弹层）**：`src/editor/useAnchoredPopover.ts`、`src/editor/ToastHost.tsx`、`src/editor/ColorField.tsx`、`src/editor/TokenBinding.tsx`、`src/editor/ComponentProperties.tsx`、`src/editor/TooltipHost.tsx`、`src/editor/canvas-feel.css`（`@layer panels`，0 `!important`）、`tests/inspector-popovers-toast.test.ts`
- [x] **Track 3（右栏全量 15 个子面板修复）**：`PrototypeInspector.tsx`、`DevModePanel.tsx`、`ExportPanel.tsx`、`batch-export.ts`、`SelectionColors.tsx`、`ImageInspector.tsx`、`GradientEditor.tsx`、`VectorInspector.tsx`、`ScalePanel.tsx`、`GridTracks.tsx`、`LayoutGuidesInspector.tsx`、`LayoutBreakpoints.tsx`、`SizeLimits.tsx`、`PaintStack.tsx`、`PanelDivider.tsx`、`property-icons.tsx`、`tests/inspector-subpanels-audit.test.ts`

---

## 阶段三：Wave 2 主干集成（Track 4）与独立只读复审
- [x] **Track 4（主 Inspector + 提案保护 + App 集成 + E2E）**：`src/domain/node.ts`、`src/domain/scale-tool.ts`、`src/domain/vector-outline.ts`、`src/infrastructure/storage.ts`、`src/infrastructure/storage-parts.ts`、`useDocument.ts`、`useEditor.ts`、`Canvas.tsx`、`SmartHandles.tsx`、`Inspector.tsx`、`App.tsx`、`WorkspaceShell.tsx`、`WorkspaceHomeShell.tsx`、`scripts/check-inspector-ux.browser.js`、`scripts/run-browser-checks.mjs`、`tests/inspector-integrity.test.ts`
- [x] 独立只读 Codex CLI Code Review（累计 18 轮深度复审与回归闭环，正式签核 **VERDICT: PASS (0 P0 / 0 P1)**）
- [x] 全量门禁：`npm run format:check`、`npm run lint:arch`（0 违规，`as any: 1/1`，`CSS !important: 3/25`）、`npm test`（**1,570 / 1,571 通过，0 失败，1 跳过**，净增 **+246** 项）、`npm run build` 全过

---

## 阶段四：真实多视口 E2E、2× Retina 实拍与 v0.18.0 桌面发版
- [x] 跑通 `inspector-ux`（40 组 4 档视口 × 双栏宽严格 ≥ 12px 边距、2 组 Toast 避让、默认中文标题「让好设计，发生。」转轮廓并撤销、多选控件保真）+ `storage` 等共 **24 / 24** 项静态预览真实 Chromium E2E + `npm run test:exports -- canvas-phase2`
- [x] 采集 4 张 2× Retina 深浅双主题实拍并逐张人工核验（`docs/evidence/2026-11-28/inspector-ux-v18/`）
- [x] 同步更新 `docs/ARCHITECTURE.md`、`docs/specs/EDITOR-UI-CONTROLS.md`、`docs/initiatives/`、`docs/HANDOFF.md`、`docs/EDITOR-ACCEPTANCE.md`
- [x] 运行 `npm run release:run` 发布 **`v0.18.0`** 并完成只读挂载 `Forma-0.18.0-arm64.dmg` 实机验收
