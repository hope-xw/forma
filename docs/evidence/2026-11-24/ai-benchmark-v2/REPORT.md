# Forma AI 生成引擎 V1 → V2 同模型同题代际实拍对比报告

- **评测日期**：2026-11-24
- **版本与环境**：Forma `0.8.4` 工作区（macOS Apple Silicon，Node 25.8.0，Playwright Chromium 2× Retina）
- **评测控制变量**：**完全相同的模型**（真实云端 `DeepSeek-V4.1-Flash`）、**完全相同的咖啡 H5 需求**（「微光烘焙 · Lumina Roasters」390×844 移动 H5 精品咖啡订阅与点单首页）、**完全相同的 Forma 原生画布渲染器**（所有实拍均来自编译进 Forma 原生可编辑图层后的 100% 缩放截图，非 HTML 预览截图）
- **关联文档**：[课题 PRD](../../../initiatives/2026-11-24-ai-generation-v2/PRD.md) · [工程设计](../../../initiatives/2026-11-24-ai-generation-v2/ENGINEERING.md) · [任务清单](../../../initiatives/2026-11-24-ai-generation-v2/TASKS.md) · [V2 长期规格](../../../specs/AGENT-GENERATION-V2.md)
- **对比产物**：[五栏 V1 vs V2 实拍大图](v1-vs-v2.png) · [交互对照网页](v1-vs-v2.html) · [4 屏并排可编辑原稿 ALL-V1-V2-comparison.forma.json](ALL-V1-V2-comparison.forma.json) · [原始数据 results.json](results.json)

---

## 一、V1 vs V2 核心指标与视觉飞跃对照

| 组别 | 引擎架构 | 原生图层数 | AutoLayout | 实景摄影层 / 入库图 | Lucide 矢量图标 | 毛玻璃层 (`backdropBlur`) | 层次投影层 | `lowContrast` | 可编辑原稿与实拍 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **V1-A（纯文本基线）** | V1 专有 JSON 蓝图 | 112 | 86% | 0 / 0 | 0 | 0 | 少数 | 2 | [V1-A.forma.json](../ai-benchmark/A-text-only.forma.json) · [实拍](../ai-benchmark/A-text-only.png) |
| **V2-A（纯文本新版）** | **V2 HTML-First + 摄影 + Lucide + 自审** | **130** | 78% | **3 / 3** | **19** | **6** | **24** | 12（服务端估算） | [V2-A.forma.json](V2-A-text-html-first.forma.json) · [实拍](V2-A-text-html-first.png) |
| **V1-D（旧架构最佳）** | V1 参考图 + 社区 Skill 蓝图 | 101 | 96% | 0 / 0 | 0 | 0 | 少数 | **0** | [V1-D.forma.json](../ai-benchmark/D-image-plus-oss-and-forma-skills.forma.json) · [实拍](../ai-benchmark/D-image-plus-oss-and-forma-skills.png) |
| **V2-B 初稿（自审前）** | V2 HTML-First（含 `@keyframes` 动画隐患） | 113 | 82% | 3 / 3 | 14 | 4 | 13 | **0** | [V2-B-draft.forma.json](V2-B-image-skills-html-first-draft.forma.json) · [实拍](V2-B-image-skills-html-first-draft.png) |
| **V2-B 终稿（视觉自审后）** | **V2 HTML-First + 参考图 + 社区 Skill + 1 轮截屏自审** | **127** | **80%** | **3 / 3** | **14** | **4** | **16** | **0** | [V2-B.forma.json](V2-B-image-skills-html-first.forma.json) · [实拍](V2-B-image-skills-html-first.png) |

---

## 二、四项决定性实测发现

1. **同模型不换 API，纯靠架构升级完成代际跨越**：
   - 同样是零参考图纯文本，**V2-A** 直接从 V1-A 的「纯色方块编号 + 圆点假图标」跃升为暖奶油编辑风 + 双列咖啡豆 Bento 网格 + 3 张高清咖啡实景摄影 + 19 枚精准居中 Lucide 矢量图标 + 6 层毛玻璃 + 24 层精致阴影。
2. **多模态「睁眼看图」视觉自审在真实案例中立大功（V2-B 初稿 → 终稿）**：
   - **V2-B 初稿** 因模型在 CSS 里写了 `@keyframes rise { from { opacity: 0 } }` 入场动画，在静态编译抓帧时主视觉标题与按钮全部处于隐身状态，且 6 枚分类胶囊中右侧「茶感」贴边；
   - 将渲染后的真实 Forma PNG 截屏回喂给 DeepSeek-V4.1-Flash 后，模型在 **47.2s** 内直接看图诊断出根因，删除动画并恢复了「✦ 本季手冲 / 茉莉、白桃，还有一点佛手柑 / 查看冲煮方案」主视觉与双层压暗遮罩，并将 6 枚胶囊精准收口在 350px 内，最终实现 **0 对比度问题**；
   - 我们同步在 [html-forma-sandbox.ts](../../../../src/editor/html-forma-sandbox.ts) 复位样式中永久加入 `animation:none!important;transition:none!important`，从源头彻底根治静态编译被入场动画隐藏的问题。
3. **像素级真机排查同步修复 3 项真实编译器与协议边界**：
   - CSS 多层叠加渐变按 Forma `stackPaints()` 从上到下顺序映射为 `gradient + paints`，彻底修复浅色多渐变叠加画板背景丢失；
   - 单格 `display: grid; place-items: center` 图标按钮映射为居中 AutoLayout 并归零 `:where(button)` 浏览器默认内边距，实现圆形 `bell`/`bookmark`/`+` 图标亚像素居中；
   - `adapters.ts` 补齐 DeepSeek 偶发正文泄漏 `<｜DSML｜invoke>` XML 自动恢复为标准 `toolCalls`，默认工具轮数上限提至 10。
4. **100% 原生可编辑与单步撤销验收通过**：
   - 在真实 Chromium 编辑器打开 [V2-B-image-skills-html-first.forma.json](V2-B-image-skills-html-first.forma.json)，`⌘+点击` 选中深层嵌套文本图层「粉红波旁」（`html-0-74`），在右栏修改为「粉红波旁 · V2 手改实测」确认画布实时更新，再按 `⌘Z` 单步完整恢复原文。

---

## 三、全量工程验证汇总

- **单元测试 `npm test`**：**374 / 374 通过**（较 V1 基线 327 项新增 **47 项**测试，覆盖 369 枚 Lucide 图标、SSRF 媒体管线、HTML-to-Forma 编译、多层渐变与单格网格居中、DSML 恢复及 `/api/agent/critique`）；
- **格式与构建**：`npm run format:check`、`npm run build`（`tsc --noEmit && vite build`）、`npm run desktop:agent` 全部通过；
- **真实浏览器 E2E**：**4 / 4 通过**（`agent-canvas-chat` 实测 `htmlFirstCompiled: true`、`visualCritiqueVerified: true`、`critiqueCancellationKeptDraft: true` + `optional-gateway` + `mcp` + `editor-panels`）。
