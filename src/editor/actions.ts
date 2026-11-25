export type ActionId =
  | "createComponent"
  | "createFrame"
  | "createSection"
  | "createSlice"
  | "createText"
  | "wrapSection"
  | "selectMatching"
  | "toggleDevStatus"
  | "scaleTool"
  | "pencilTool"
  | "commentTool"
  | "tidy"
  | "union"
  | "subtract"
  | "intersect"
  | "exclude"
  | "cut"
  | "copy"
  | "paste"
  | "pasteHere"
  | "duplicate"
  | "delete"
  | "selectAll"
  | "group"
  | "ungroup"
  | "wrapFrame"
  | "autoLayout"
  | "front"
  | "back"
  | "forward"
  | "backward"
  | "lock"
  | "hide"
  | "rename"
  | "undo"
  | "redo"
  | "fit"
  | "fitSelection"
  | "mask"
  | "releaseMask"
  | "rulers"
  | "zoom100"
  | "copyStyle"
  | "pasteStyle"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignTop"
  | "alignMiddle"
  | "alignBottom"
  | "distributeX"
  | "distributeY";

export interface EditAction {
  id: ActionId;
  label: string;
  keywords: string;
  category: "编辑" | "组织与组件" | "排列与对齐" | "视图";
  shortcut?: string;
  selection?: boolean;
}

export const editActions: EditAction[] = [
  {
    id: "createComponent",
    label: "创建组件",
    keywords: "component master create",
    category: "组织与组件",
    shortcut: "⌥ ⌘ K",
    selection: true,
  },
  {
    id: "undo",
    label: "撤销",
    keywords: "undo back",
    category: "编辑",
    shortcut: "⌘ Z",
  },
  {
    id: "redo",
    label: "重做",
    keywords: "redo forward",
    category: "编辑",
    shortcut: "⇧ ⌘ Z",
  },
  {
    id: "cut",
    label: "剪切",
    keywords: "cut",
    category: "编辑",
    shortcut: "⌘ X",
    selection: true,
  },
  {
    id: "copy",
    label: "复制",
    keywords: "copy",
    category: "编辑",
    shortcut: "⌘ C",
    selection: true,
  },
  {
    id: "paste",
    label: "粘贴",
    keywords: "paste",
    category: "编辑",
    shortcut: "⌘ V",
  },
  {
    id: "pasteHere",
    label: "原位粘贴",
    keywords: "paste over in place",
    category: "编辑",
    shortcut: "⇧ ⌘ V",
  },
  {
    id: "duplicate",
    label: "创建副本",
    keywords: "duplicate clone",
    category: "编辑",
    shortcut: "⌘ D",
    selection: true,
  },
  {
    id: "delete",
    label: "删除",
    keywords: "delete remove",
    category: "编辑",
    shortcut: "⌫",
    selection: true,
  },
  {
    id: "createFrame",
    label: "插入画板",
    keywords: "frame artboard insert",
    category: "组织与组件",
    shortcut: "F → Enter",
  },
  {
    id: "createSection",
    label: "插入画布分区",
    keywords: "section area group container insert",
    category: "组织与组件",
    shortcut: "⇧ S",
  },
  {
    id: "createSlice",
    label: "插入导出切片",
    keywords: "slice export crop region",
    category: "组织与组件",
    shortcut: "S",
  },
  {
    id: "createText",
    label: "插入文本",
    keywords: "text type insert",
    category: "组织与组件",
    shortcut: "T → Enter",
  },
  {
    id: "wrapSection",
    label: "包裹为画布分区",
    keywords: "wrap in new section group frames",
    category: "组织与组件",
    shortcut: "⇧ S",
    selection: true,
  },
  {
    id: "selectMatching",
    label: "选择匹配图层",
    keywords: "select matching layers same name batch",
    category: "编辑",
    shortcut: "⌥ ⌘ A",
    selection: true,
  },
  {
    id: "toggleDevStatus",
    label: "切换待开发标记 (Ready for dev)",
    keywords: "ready for dev status handoff",
    category: "组织与组件",
    selection: true,
  },
  {
    id: "scaleTool",
    label: "比例缩放工具",
    keywords: "scale proportional resize k",
    category: "编辑",
    shortcut: "K",
  },
  {
    id: "pencilTool",
    label: "铅笔自由绘工具",
    keywords: "pencil draw freehand sketch",
    category: "编辑",
    shortcut: "⇧ P",
  },
  {
    id: "commentTool",
    label: "画布评论工具",
    keywords: "comment pin review feedback c",
    category: "视图",
    shortcut: "C",
  },
  {
    id: "selectAll",
    label: "全选",
    keywords: "select all",
    category: "编辑",
    shortcut: "⌘ A",
  },
  {
    id: "group",
    label: "编组",
    keywords: "group selection",
    category: "组织与组件",
    shortcut: "⌘ G",
    selection: true,
  },
  {
    id: "union",
    label: "形状联集",
    keywords: "boolean union combine",
    category: "组织与组件",
    selection: true,
  },
  {
    id: "subtract",
    label: "减去顶层",
    keywords: "boolean subtract",
    category: "组织与组件",
    selection: true,
  },
  {
    id: "intersect",
    label: "形状交集",
    keywords: "boolean intersect",
    category: "组织与组件",
    selection: true,
  },
  {
    id: "exclude",
    label: "排除重叠",
    keywords: "boolean exclude",
    category: "组织与组件",
    selection: true,
  },
  {
    id: "ungroup",
    label: "取消编组",
    keywords: "ungroup",
    category: "组织与组件",
    shortcut: "⇧ ⌘ G",
    selection: true,
  },
  {
    id: "wrapFrame",
    label: "包裹为画板",
    keywords: "frame selection wrap",
    category: "组织与组件",
    shortcut: "⌥ ⌘ G",
    selection: true,
  },
  {
    id: "autoLayout",
    label: "添加自动布局",
    keywords: "auto layout flex",
    category: "组织与组件",
    shortcut: "⇧ A",
    selection: true,
  },
  {
    id: "front",
    label: "置于顶层",
    keywords: "bring to front top",
    category: "排列与对齐",
    shortcut: "⌘ ]",
    selection: true,
  },
  {
    id: "back",
    label: "置于底层",
    keywords: "send to back bottom",
    category: "排列与对齐",
    shortcut: "⌘ [",
    selection: true,
  },
  {
    id: "forward",
    label: "上移一层",
    keywords: "bring forward",
    category: "排列与对齐",
    shortcut: "]",
    selection: true,
  },
  {
    id: "backward",
    label: "下移一层",
    keywords: "send backward",
    category: "排列与对齐",
    shortcut: "[",
    selection: true,
  },
  {
    id: "lock",
    label: "锁定 / 解锁",
    keywords: "lock unlock",
    category: "编辑",
    shortcut: "⇧ ⌘ L",
    selection: true,
  },
  {
    id: "hide",
    label: "隐藏 / 显示",
    keywords: "hide show visibility",
    category: "编辑",
    shortcut: "⇧ ⌘ H",
    selection: true,
  },
  {
    id: "rename",
    label: "重命名",
    keywords: "rename layer",
    category: "编辑",
    shortcut: "⌘ R",
    selection: true,
  },
  {
    id: "copyStyle",
    label: "复制样式",
    keywords: "copy properties style",
    category: "编辑",
    shortcut: "⌥ ⌘ C",
    selection: true,
  },
  {
    id: "pasteStyle",
    label: "粘贴样式",
    keywords: "paste properties style",
    category: "编辑",
    shortcut: "⌥ ⌘ V",
    selection: true,
  },
  {
    id: "fit",
    label: "缩放至全部内容",
    keywords: "zoom to fit all",
    category: "视图",
    shortcut: "⇧ 1",
  },
  {
    id: "fitSelection",
    label: "缩放至选区",
    keywords: "zoom to selection",
    category: "视图",
    shortcut: "⇧ 2",
    selection: true,
  },
  {
    id: "mask",
    label: "用作蒙版",
    keywords: "use as mask clip",
    category: "组织与组件",
    shortcut: "⌃ ⌘ M",
    selection: true,
  },
  {
    id: "releaseMask",
    label: "解除蒙版",
    keywords: "release remove mask",
    category: "组织与组件",
    selection: true,
  },
  {
    id: "rulers",
    label: "显示或隐藏标尺",
    keywords: "rulers guides",
    category: "视图",
    shortcut: "⇧ R",
  },
  {
    id: "zoom100",
    label: "缩放至 100%",
    keywords: "zoom 100 actual size",
    category: "视图",
    shortcut: "⇧ 0",
  },
  {
    id: "tidy",
    label: "智能整理",
    keywords: "tidy up smart selection",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "alignLeft",
    label: "左对齐",
    keywords: "align left",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "alignCenter",
    label: "水平居中",
    keywords: "align horizontal center",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "alignRight",
    label: "右对齐",
    keywords: "align right",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "alignTop",
    label: "顶对齐",
    keywords: "align top",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "alignMiddle",
    label: "垂直居中",
    keywords: "align vertical middle",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "alignBottom",
    label: "底对齐",
    keywords: "align bottom",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "distributeX",
    label: "水平等距分布",
    keywords: "distribute horizontal spacing",
    category: "排列与对齐",
    selection: true,
  },
  {
    id: "distributeY",
    label: "垂直等距分布",
    keywords: "distribute vertical spacing",
    category: "排列与对齐",
    selection: true,
  },
];
