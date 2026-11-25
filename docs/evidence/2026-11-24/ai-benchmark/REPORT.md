# Forma 真实 AI 生成对比评测与开源社区设计 Skill 兼容性报告

- **评测日期**：2026-11-24
- **版本与环境**：Forma `0.8.4` 工作区（macOS Apple Silicon，Node 25.8.0，Playwright Chromium 2× Retina）
- **云端模型**：DeepSeek `deepseek-flash`（`DeepSeek-V4.1-Flash`，实时 `/v1/models` 声明 `1M` 上下文、`384K` 输出、`input_modalities: ["text", "image"]`、原生工具调用与深度推理）
- **关联规格**：[原生工具调用与第三方 Skill 生态规格](../../../specs/AGENT-TOOLS-AND-SKILLS.md) · [多模型配置与能力规格](../../../specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md)
- **原始数据与可交互对比页**：[results.json](results.json) · [六栏对照网页 comparison.html](comparison.html) · [六栏对照图 comparison.png](comparison.png) · [修复前后对照 before-after.html](before-after.html) · [修复前后对照图 before-after.png](before-after.png)

> 结论边界：本评测覆盖同一「微光烘焙 · Lumina Roasters」390×844 移动 H5 精品咖啡订阅首页需求在 5 组控制变量下的真实云端实测样本，以及从 GitHub 实际下载的 9 款主流开源设计 Skill。

---

## 一、五组控制变量真实生成对比（A / B / C / D / E）

五组均从同一空白画布底座出发（继承 [mobile-studio.forma.json](../../../../public/examples/mobile-studio.forma.json) 的真实设计系统变量与 `forma-mobile-v1` 原生组件库，清空画布图层，保证各组隔离可比）。参考图取自 Forma 内置 [Aura 移动 H5 官网画板](ref-aura-mobile.png)。

| 组别 | 输入条件 | 耗时 | 图层数 | AutoLayout | 复用原生组件 | 激活 Skill | 对比度问题 | 越界提示（服务端估算） | 重叠 / 空文 | 未绑定变量提示 | 交付文件与实拍 |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| **A** | 纯文本基线（无参考图 / 无 Skill） | 165.0s | 112 | 86% (43/50) | 0 | 无 | 2 | 13 | 0 / 0 | 85 | [A.forma.json](A-text-only.forma.json) · [实拍](A-text-only.png) |
| **B** | 参考图 + 文本（多模态识图 / 无 Skill） | 122.7s | 129 | 95% (57/60) | 1 | 无 | **0** | 3 | 1 / 0 | 93 | [B.forma.json](B-image-plus-text.forma.json) · [实拍](B-image-plus-text.png) |
| **C** | 纯文本 + 3 款社区 Skill（`frontend-design` + `ui-ux-pro-max` + `better-colors`） | 235.1s | 145 | 98% (64/65) | 1 | 3 款社区 Skill | **0** | 27 | 0 / 0 | 73 | [C.forma.json](C-text-plus-oss-skills.forma.json) · [实拍](C-text-plus-oss-skills.png) |
| **D** | 参考图 + 文本 + 社区 Skill + `forma-design-system-craft` | 180.1s | 101 | 96% (43/45) | **2** | 2 社区 + 1 内置 | **0** | 14 | 1 / 0 | 69 | [D.forma.json](D-image-plus-oss-and-forma-skills.forma.json) · [实拍](D-image-plus-oss-and-forma-skills.png) |
| **E** | 社区 `theme-factory` 定向主题迁移（`themes/golden-hour.md`） | **82.3s** | 76 | **100%** (40/40) | 0 | `theme-factory` | 5 | 1 | 0 / 0 | 53 | [E.forma.json](E-theme-factory-golden-hour.forma.json) · [实拍](E-theme-factory-golden-hour.png) |

### 视觉与工程观察结论

1. **参考图迁移有效（B vs A）**：A 组输出稳妥浅米色电商风格（`#f7f2ea`）；B 组实测多模态视觉理解生效，准确吸收 Aura Mobile 参考图的深空炭黑（`#0f1115`）、暗色悬浮卡与细腻边框语言，同时完全围绕精品咖啡业务独立创作。
2. **开源社区 Skill 实测起效（C vs A）**：C 组未提供参考图，DeepSeek 主动调用 **4 次** `search_skill_resources` 离线检索 `ui-ux-pro-max` 的 CSV 数据表（零脚本执行），结合 `frontend-design` 反模板化美学与 `better-colors` 配色纪律，产出深烘底 + 羊皮纸编辑感 Hero + 四维风味强度柱图 + 烘焙度刻度点，对比度问题降至 `0`。同时仍保留客观微瑕（Hero 内边距为 0、底栏上方促销横幅在 844px 高度下轻度探出）。
3. **参考图 + 社区 Skill + Forma 设计系统综合最佳（D 组）**：同时实现暗夜通透层级、衬线展示标题、鼠尾草绿/陶土棕咖啡豆卡片渐变、顶部单边细分隔线（`strokeSides: ["top"]`）、复用 2 枚 `forma-mobile-v1` 原生组件（状态栏与底部指示条），Chromium 实拍**零视觉裁剪、零重叠、零对比度问题**。实测在 Chromium 编辑器打开 `D-image-plus-oss-and-forma-skills.forma.json`，选中文本节点修改为「微光烘焙 · 已手动编辑」并按 `⌘Z` 单步完整撤销还原。
4. **定向主题类社区 Skill 确定性高（E 组）**：模型按 `activate_skill("theme-factory") → read_skill_resource("themes/golden-hour.md") → propose_design_changes` 82.3s 一次性提交通过，100% AutoLayout，精确落地官方 4 色（`#f4a900`、`#c1666b`、`#d4b896`、`#4a403a`）。
5. **变量绑定与品牌定制色权衡**：五组均围绕咖啡品牌色板创作，与 `mobile-studio` 预置浅蓝/冷灰设计系统变量色值不同，因此 `tokensBound` 均为 `0`，提示 53–93 项 `unbound-color`；如需强绑定现有 Token，须在需求中显式指定沿用现有主题变量。

---

## 二、真网实测暴露并修复的 8 项关键缺陷

在真机跑 DeepSeek 过程中发现并完成了以下闭环修复（见[修复前后实拍对比](before-after.png)）：

1. 子 `frame` 无显式填充时不再继承默认白底 `#ffffff` 与 `padding: 16`，改为透明 `fillOpacity: 0`、`radius/padding/gap: 0`；
2. 子层省略尺寸时按父容器方向（`row` / `column`）自动推导 `hug` / `fill`，解决行内搜索栏被压成单字竖排与胶囊膨胀；
3. 新增 `fill: "none"` 透明色解析，以及仅声明描边而未设填充的 `ellipse`/`rectangle` 默认 `fillOpacity: 0`，彻底消除暗色画板装饰环出现纯白实心圆；
4. `strokeSides` 兼容数组（`["top"]`）与布尔对象（`{ top: true }`）并自动将其余边清零（`0..64`），同时兼容 CSS 数组/方向边距与圆角简写（`padding: [v, h]`、`paddingX`/`paddingY`、`corners: [...]`），避免非标准字段直接抛错炸毁整份画板；
5. `FormaToolExecutor` 补齐超长 JSON 参数尾随字符容错（`extractJsonPayload` 回退）并允许 `propose_design_changes` 附带额外元数据键；
6. `propose_design_changes` 成功后直接回传影子提案 `lintSummary`，且 `lint_design`/`get_node_details`/`search_nodes` 支持查询影子提案；引擎与 `/api/agent/chat` 超时放宽至 `240s`。

---

## 三、9 款主流开源社区设计 Skill 兼容性实测矩阵

从 4 个社区高频开源仓库真实下载并导入测试了 9 款设计 Skill（总计 52 份本地参考文档与 CSV/JSON 数据表）：

| 开源来源 | Skill | 本地配套资源 | 改造前索引 | 改造后索引 | Forma 兼容分级 | 实测方式与结果 |
| --- | --- | --- | ---: | ---: | --- | --- |
| `anthropics/skills` | `frontend-design` | 0（纯 `SKILL.md`） | 0/0 | 0/0 | `native`（完全兼容） | 经画布语义桥接在 C/D 组稳定输出原生图层，无 HTML 泄漏 |
| `anthropics/skills` | `brand-guidelines` | 0（纯 `SKILL.md`） | 0/0 | 0/0 | `native`（完全兼容） | 完整索引并可直接激活 |
| `anthropics/skills` | `theme-factory` | `themes/*.md` ×10（另含 PDF 安全跳过） | 0/10 | **10/10** | `native`（完全兼容） | E 组实测读取 `themes/golden-hour.md` 精准还原 4 色 |
| `nextlevelbuilder/ui-ux-pro-max-skill` | `ui-ux-pro-max` | `data/*.csv` + `data/stacks/*.csv` + `data/*.json` ×26 + `scripts/search.py` | 0/26 | **26/26** | `adapted`（本地检索适配） | 禁用 Python 脚本，以内置 `search_skill_resources` 离线检索命中 `data/colors.csv:64` 与 `data/products.csv:39/64`；C 组实测调用 4 次 |
| `jakubkrehel/skills` | `better-colors` | 根目录伴随文档 `*.md` ×7 | 0/7 | **7/7** | `native`（完全兼容） | 全部 7 份配色规范安全索引；C 组对比度问题为 0 |
| `jakubkrehel/skills` | `better-typography` | 根目录伴随文档 `*.md` ×7 | 0/7 | **7/7** | `native`（完全兼容） | 全部 7 份排字规范安全索引 |
| `jakubkrehel/skills` | `better-interface` | 根目录伴随文档 `*.md` ×1 | 0/1 | **1/1** | `native`（完全兼容） | `review-format.md` 安全索引 |
| `jakubkrehel/skills` | `build-design` | 根目录伴随文档 `*.md` ×1 | 0/1 | **1/1** | `native`（完全兼容） | `figma.md` 安全索引 |
| `vercel-labs/agent-skills` | `web-design-guidelines` | 0（正文依赖 `WebFetch` 远端 URL） | 0/0 | 0/0 | `limited`（外部依赖受限） | 自动标示为「外部依赖受限」并提示补充本地规则文档后离线使用 |
| **合计** | **9 款** | **52 份本地配套资源** | **0 / 52** | **52 / 52** | **7 完全兼容 · 1 检索适配 · 1 外部受限** | 全量通过导入、安全边界校验与弹窗 UI 分级展示 |

---

## 四、回归验证记录

- 全仓单元测试 `npm test`：**327 / 327 通过**（新增覆盖社区目录索引、离线 CSV/Markdown 检索、三级兼容诊断、子层透明底与父布局 `hug/fill`、影子提案体检、`strokeSides` 数组/布尔与 `fill:"none"`/CSS 简写归一化、JSON 尾随字符容错）；
- 代码格式校验 `npm run format:check`、TypeScript 严检与生产构建 `npm run build`、桌面 Agent 打包 `npm run desktop:agent` 全部通过；
- 真实浏览器端到端回归 **4 / 4 通过**（`agent-canvas-chat`、`optional-gateway`、`mcp`、`editor-panels`）。
