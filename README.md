# Forma 设计平台

Forma 是面向设计师的本地设计工具。你可以从空白画板开始，也可以导入 Sketch 或 Figma 文件，编辑图层和组件、预览交互，再导出可运行的 React + TypeScript 工程。手动编辑、组件库、原型预览和工程导出都可以离线使用。

**[下载 Forma 0.12.0 · macOS Apple Silicon（DMG）](https://github.com/hope-xw/forma/releases/download/v0.12.0/Forma-0.12.0-arm64.dmg)** · [最新发布与 ZIP 下载](https://github.com/hope-xw/forma/releases/latest) · [版本日志](docs/CHANGELOG.md)

打开 DMG，把 Forma 拖入「应用程序」。此安装包使用本地 ad-hoc 签名，尚未经过 Apple 公证，macOS 首次打开时可能显示安全提示。

## 用一个样例走完设计到交付

1. 在「文件」菜单选择「打开移动设计研究室」，从样例中选择一个画板。也可以选择「打开设计文件…」，载入自己的 `.sketch` 或 `.fig`，查看导入报告后点击「导入为新文件」。[导入兼容范围](docs/specs/DESIGN-FILE-IMPORT.md)
2. 选中图层修改文字、布局或样式。按 **⌥3** 打开组件库管理中心，为当前文件启用 Forma Mobile、Material Design 3、Ant Design 5 或 shadcn/ui，再从「资源」面板拖入组件。四个内置库共提供 98 类组件和 10 套整页模板。[组件库使用说明](docs/specs/COMPONENT-LIBRARY-MANAGEMENT.md)
3. 在右侧「原型」栏设置画板跳转或浮层，打开预览检查交互。顶栏可以导出当前画板及其原型目标；要交付所有页面，在「文件」菜单选择「导出整个文件为 React 项目…」。导出的工程包含组件、资源和设计变量，后续设计改版也可以更新到已有工程。[工程更新方法](docs/specs/REACT-PROJECT-UPDATES.md)

## 使用 Forma AI

在 Forma AI 面板选择模型供应商，按提示填写凭据并连接，然后选择模型和目标组件库。你可以让 AI 生成整屏，也可以选中已有图层提出局部修改。对于多页需求，先确认生成范围，再预览生成的画板并决定是否采纳。[模型配置](docs/specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md) · [使用组件库生成设计](docs/specs/FORMA-AI-LIBRARY-AND-MEMORY.md)

## 从源码运行 Web 编辑器

建议使用 Node.js 22.12 或更高版本。在项目根目录运行以下命令，然后打开 Vite 在终端显示的本机地址。

```sh
npm ci
npm run dev
```

Web 开发模式和桌面版都内置了本机 Agent 服务。需要让外部 MCP 客户端与 Web 编辑器共享会话时，可以在另一终端运行 `npm run dev:agent`。服务端模型环境变量见 [.env.example](.env.example)。

| 开发操作 | 命令 |
| --- | --- |
| 运行单元测试 | `npm test` |
| 检查架构依赖边界 | `npm run lint:arch` |
| 检查格式、构建 Web 版 | `npm run format:check`、`npm run build` |
| 检查编辑器操作 | 启动 Web 编辑器后运行 `npm run test:browser` |
| 验证界面导出的 React 工程 | 完成浏览器导出用例后运行 `npm run test:exports` |

## 项目文档

- [编辑器验收记录](docs/EDITOR-ACCEPTANCE.md) · [可编辑的 Aura 样例文件](public/examples/aura-showcase.forma.json)
- [规格目录](docs/specs/README.md) · [设计系统与变量](docs/DESIGN-SYSTEM.md) · [移动组件库](docs/MOBILE-LIBRARY.md)
- [项目架构](docs/ARCHITECTURE.md) · [项目交接与待办](docs/HANDOFF.md) · [桌面打包与发布](docs/specs/VERSIONING-AND-DESKTOP.md)

## 许可证

Forma 的原创代码采用 [MIT 许可证](LICENSE)。第三方依赖和素材遵循各自的许可条款。
