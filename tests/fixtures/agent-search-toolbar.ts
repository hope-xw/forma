import type { DesignBlueprint } from "../../src/agent/blueprint-compiler";

export const searchToolbarBlueprint: DesignBlueprint = {
  mode: "generate",
  reply: "已生成发现页",
  artboards: [
    {
      type: "frame",
      name: "发现页",
      children: [
        {
          type: "frame",
          name: "深色横幅",
          style: { fill: "#14283c", padding: 16 },
          children: [
            {
              type: "frame",
              name: "标题容器",
              children: [
                {
                  type: "text",
                  name: "标题",
                  text: "发现附近的展览",
                  style: { color: "#ffffff" },
                },
              ],
            },
          ],
        },
        {
          type: "frame",
          name: "搜索工具栏",
          style: { layout: "row", gap: 8, alignY: "center" },
          children: [
            {
              type: "frame",
              name: "搜索框",
              style: {
                layout: "row",
                widthMode: "fill",
                fill: "#edf1f5",
                padding: 8,
              },
              children: [
                { type: "text", name: "搜索提示", text: "搜索展览与活动" },
              ],
            },
            {
              type: "frame",
              name: "筛选胶囊",
              style: {
                layout: "row",
                fill: "#203448",
                radius: 16,
                insets: { left: 8, right: 8, top: 4, bottom: 4 },
              },
              children: [
                {
                  type: "text",
                  name: "筛选标签",
                  text: "筛选",
                  style: { color: "#ffffff" },
                },
              ],
            },
            {
              type: "button",
              name: "地图按钮",
              text: "地图",
              style: { fill: "#203448" },
            },
          ],
        },
      ],
    },
  ],
};
