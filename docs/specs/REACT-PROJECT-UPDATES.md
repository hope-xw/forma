# React 工程与改版更新

最近更新日期 2026-11-23 · 状态 **已实施并验收**

关联源码 [工程生成器](../../src/compiler/runtime.ts)、[独立组件](../../src/compiler/component-project.ts)、[ZIP 与入口](../../src/infrastructure/export-project.ts)、[版本清单和冲突判断](../../src/infrastructure/project-revision.ts)。

整文件导出的 `DesignPage` 接受 `screen?: string`。业务路由可以将自己的地址映射到稳定的画板 ID，例如 `#/orders/42` 映射到 `Detail`。没有传值时沿用原画板目录和 `#screen=` 深链接。业务入口由开发维护，更新现有工程后保留。打开内层原型弹窗时焦点进入该弹窗，Tab 留在当前层；Esc 或关闭动作返回本层触发按钮。

1. 顶栏导出当前画板与原型依赖。文件菜单可以导出整份文件，按页加载。源码 ZIP 含设计文档、资源、CSS/TS Token、运行时及 `forma-project.json`。在工程目录运行 `npm install`、`npm run build` 或 `npm run dev`。
2. 开发在 `src/business.ts` 实现 `onDesignAction(id, value)`，也可自行维护入口、配置和其他文件。使用过的库组件按稳定的库与组件 ID 生成到 `src/components/`。生成页把各实例的实际覆盖交给对应组件。业务页可单独 import 默认组件，传入唯一 `instanceId`、`variant`、按模板键指定的 `text`、按公开名称映射的 `values` 和可选回调。生成的变体组件也接受类型化的 `variantProperties`，例如按 State 和尺寸选择完整组合。嵌套替换字段接收 React 子组件。根控件回调使用实例 ID。
3. 设计改版后，从文件菜单选「更新已有 React 工程…」，选择开发已修改的源码 ZIP。可包含一个外层目录，排除依赖目录、构建输出和 Git 仓库。输入上限 512 MiB，展开总量上限 1 GiB。超过 128 个节点的页面使用单独的 `*.nodes.json`，经页面模块按需装载。工程内的 `design.forma.json` 与原生另存共用同一格式。成功后另存 `forma-react-updated.zip`。
4. 清单协议为 `forma/react-project/1`，记录原文件 ID、页、导出范围、根画板 ID 和生成文件 SHA-256。同时改了同一生成文件时阻止输出并列出冲突路径；仍需要而被删除的生成文件会提示恢复。仅开发侧改动且设计侧内容相同的生成文件保留现状。设计删除、开发未改的生成文件随更新移除。业务代码、入口、配置与新增文件由开发保留。
5. 当前版本以前没有清单的工程需先重新导出，再把手写业务接入新工程。选择其他设计文件的 ZIP、缺少原选区或非法 ZIP 时，编辑器提示原因。

验收使用 `designer-delivery` 浏览器场景和同名独立工程用例。实际操作包括接入邮箱和提交回调、改卡片跨度、检查冲突、合并、重新安装构建，并从独立工程输入和提交。非法邮箱在浏览器内被拦截；合法邮箱由本机测试 API 返回 422，修正后回传 201，界面显示成功。实际更新保留开发者的 `src/business.ts` 和 `src/feedback-client.ts`。[可运行的二次导出工程](../evidence/2026-11-20/v0.4.0/feedback-react.zip)。
