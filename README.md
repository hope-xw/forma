# Forma 设计平台

面向设计师的原生编辑、Agent 接续和 React + TypeScript 交付工具。手动画布、原型播放和 React 工程导出可在本机使用。完整产品的验收状态见[迭代计划](docs/ROADMAP.md)。

[下载 Forma 0.8.3（Apple Silicon）](release/Forma-0.8.3-arm64.dmg) · [项目版本日志](docs/CHANGELOG.md) · [打开可编辑的双页 Aura 稿](docs/evidence/2026-11-20/v0.5.0/aura-responsive.forma.json) · [桌面验收记录](docs/EDITOR-ACCEPTANCE.md)

## 开发

使用支持 Vite 7 的 Node.js（建议 Node 22.12+；当前开发机 Node 25.8）。

```sh
npm ci
npm run dev
npm test
npm run build
```

本地地址以 Vite 输出为准。没有模型密钥或外部账号也可以使用手动编辑功能。

## 手动设计与交付

- 在文件菜单选择「打开设计文件…」，选中本机的 `.sketch` 或 `.fig`，核对报告后点击「导入为新文件」。导入后可编辑图层、组件与共享样式。[兼容范围和实测差异](docs/specs/DESIGN-FILE-IMPORT.md)
- 文件菜单可以管理独立的本机文件、打开移动设计研究室、恢复上一次保存。页面、主组件、实例、变量和资源都保存在原生设计文件中。
- 画布支持多选、拖动、按视觉边界对齐分布、二维智能整理、穿透选择、剪切复制粘贴、编组、旋转翻转、钢笔锚点、参数化星形与多边形、可吸附的直线、可编辑布尔形状、富文本选区以及标尺辅助线。支持置入、粘贴或拖入基础 SVG 图标与位图。选中位图后可在画布上裁切，也可从「图像填充」平铺图片、调整亮度、对比度和饱和度。
- 右侧属性面板随选区变化。可编辑自动布局、约束、尺寸、渐变与多重填充、描边、效果、变量、样式和实例覆盖，并切换至原型栏定义交互。
- 原生移动研究室包括 iPad 分栏/分享/菜单、iPhone 控件、Soundspace 的浅深色画板和可编辑地形路线工作台。入口为文件菜单中的“打开移动设计研究室”。
- 预览和 React + TypeScript 工程共用原型播放器。支持声明的跨页导航、浮层、滚动、条件、多动作和变量。工程包含组件、图片、矢量、设计文档、Token、CSS 与开发接入回调。
- 顶栏导出当前画板及原型需要的目标。文件菜单中的“导出整个文件为 React 项目”保留全部页面，包含按页加载的模块、画板目录（`/#screens`）与画板直达链接。位图文件位于工程的 `src/assets/`。
- 浏览器操作回归默认使用本机 Chrome，也可指定 Playwright WebKit 或 Firefox 引擎。启动 Vite 后运行 `npm run test:browser`，或 `npm run test:browser -- editor-panels layer-tree` 单独检查短窗口菜单和万层列表。

当前差距与已实测的行为分列在[手动设计验收](docs/EDITOR-ACCEPTANCE.md)中。打开资源面板中的本地主组件可直接发布，另一份文件通过「在线组件库」订阅地址、挑选修订和处理冲突。桌面和本机 Web 已有本机发布服务，跨电脑共享用团队服务。设计改版可从文件菜单更新已有 React 工程。[专业编辑与发布](docs/specs/PROFESSIONAL-EDITING.md) · [工程更新方法](docs/specs/REACT-PROJECT-UPDATES.md)。

## 工程资料

- [设计师操作、Figma 能力对照与补齐计划](docs/specs/EDITOR-PARITY-PLAN.md)
- [项目交接文档 · 目标、已验收进展、缺陷与下一步](docs/HANDOFF.md)
- [移动组件库能力、入口与限制](docs/MOBILE-LIBRARY.md)
- [本轮画布能力核对与快捷键](docs/CANVAS-COVERAGE.md)
- [架构与确认边界](docs/ARCHITECTURE.md)
- [本地变量与样式：使用、导出与差异](docs/DESIGN-SYSTEM.md)
- [多页工作台、移动原生样例与性能对照](docs/STUDIO-AUDIT.md)
- [迭代计划与验收](docs/ROADMAP.md)
- [Agent 事务协议](docs/AGENT-PROTOCOL.md)
- [182 条研究规格原文目录](docs/requirements/research-catalog.json)

PDF 原件保留在用户 Downloads。研究提取工具 scripts/extract_research.py 使用 PyMuPDF；每条记录保留页码和来源编号，并校验总数及各产品数量。研究日期、SHA256 与实现状态分开记录。

## 可选模型网关

已实现 OpenAI 兼容 Chat Completions 服务端适配、生成取消、事务预览与应用。采用的接口形式见 [官方 API 参考](https://developers.openai.com/api/reference/resources/chat)。兼容供应商需要支持 `response_format: json_object`。

手动设计、原型和工程导出均可在网关留空时使用。需要连接模型时，将 `.env.example` 复制为本地 `.env`，填写 `MODEL_BASE_URL`（含供应商 API 前缀，例如 `/v1`）、`MODEL_ID` 和 `MODEL_API_KEY`。密钥只由服务端读取。另一个终端执行：

```sh
npm run dev:agent
```

打开 Agent 面板会显示未连接状态，点击连接按钮才检查网关。编辑器由 Vite 将 `/api` 代理到本地 5174 端口。选择图层后生成只允许修改该子树；未选择时作用于当前页。生成期间可手动编辑，若版本发生变化，旧方案应用会被拒绝。取消或丢弃未应用方案不会修改设计。

当前服务为仅监听 loopback 的单用户开发服务，尚不包含生产身份认证与部署。自然语言真实生成尚需配置供应商后验收；测试中的模拟 HTTP 响应只验证适配器行为。

资源面板的“供 Agent 使用”会登记自研移动组件库；模型读取压缩后的组件目录，通过 insertComponent 创建原生实例。

## 许可证

Forma 的原创代码采用 [MIT 许可证](LICENSE)。第三方依赖和素材遵循各自的许可条款。
