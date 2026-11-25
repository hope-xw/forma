# Agent 事务协议与多模型接入

最近更新 2026-11-24。除既有的 [HTTP 配对服务](../server/index.ts)与升级版 7 工具 [MCP stdio 入口](../server/mcp.ts) 外，内置多模型接入已升级为「先选供应商再填 Key」显式流程、五层模型能力解析管道（实时 `/models` 元数据 + 内置目录 + 用户覆写），以及基于三协议原生 Function Calling 的多轮设计工具循环与 `SKILL.md` 开放标准第三方 Skill 引擎。详见[多模型配置、能力识别与画布对话设计规格](specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md)与[Forma Agent 原生工具调用与第三方 Skill 生态规格](specs/AGENT-TOOLS-AND-SKILLS.md)。

画布工具调用在事务通过选区校验后保留同一份影子文档。模型可用成功回执的 `createdRootIds` 继续查询图层，并按 `lintSummary` 决定是否复查。设计师采纳后才写入画布。[影子提案及回执字段](specs/AGENT-TOOLS-AND-SKILLS.md)

Web 开发/预览服务（[vite.config.ts](../vite.config.ts)）与 Electron 桌面端（[electron/main.mjs](../electron/main.mjs)）均内置回环 `/api/agent/*` 路由（存在兼容的独立 `npm run dev:agent` 监听时优先转发），密钥仅保存于本机 `0600` 配置文件且响应全脱敏。未配置任何模型时，手动设计与外部 MCP 配对仍保持零外部模型请求。

0.5.1 安装版与网页版均可使用本机可选 Agent 服务（`npm run dev:agent`）。桌面编辑器将状态、生成、会话与提案请求发往环回地址，默认端口 5174；服务识别 `forma://app` 来源。显式设置 `DEV_ORIGINS` 时须包含实际使用的编辑器来源。网关留空仍可进行外部配对、审阅、应用及撤销。

复验时启动 Web 编辑器及 `npm run dev:agent`，执行 `npm run test:browser -- mcp`。此项检查真实 stdio 握手、限定范围、提案、应用和撤销。

从 Agent 面板导出上下文取得 document 和 selection。请求提供最新 document.revision，以 operations 数组执行原子事务。失败时整个文档保持原状。

```json
{
  "baseRevision": 0,
  "operations": [
    {"type":"update","id":"读取到的节点 ID","patch":{"text":"新标题"},"style":{"fontSize":28}}
  ]
}
```

支持 create(node)、update(id, patch, style)、move(id, parentId)、remove(id)。完整输入模型在 src/domain/commands.ts。create 必须传完整合法节点，不能依赖未定义默认值。

Agent 提案已强制限定选区及后代，拒绝范围外增改删及移动；尚未校验生产身份、幂等请求或记录作者；因此不能直接开放成网络写入 API。后续服务层必须补齐 documentId、transactionId、actor、允许范围、权限与幂等校验，再开放生产级远程写入服务。

锁定节点不允许修改，可显式解除锁定。当前普通节点 locked 不代表安全权限；它只是编辑约束。删除容器包含锁定子层时整体拒绝。

## 组件库调用

在资源面板点击“供 Agent 使用”后，可提交以下操作。ID 从 componentCatalog 读取，position 是文档世界坐标。实例化在事务内展开为原生节点，同一事务只增加一次 revision；选区内任务仍禁止在选区外创建实例。

```json
{"type":"insertComponent","libraryId":"forma-mobile-v1","componentId":"toggle","variantId":"Light-On-Default","parentId":"当前选区 Frame ID","position":{"x":80,"y":120}}
```

发送给兼容模型的上下文使用 componentCatalog 代替完整库模板，以降低上下文大小。服务端保留原库做解析和校验。putLibrary 为文档级操作，选区任务不得修改全局库。模型端点未配置时不声称已实测自然语言生成。
