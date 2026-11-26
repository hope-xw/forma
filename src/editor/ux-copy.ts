import {
  FileText,
  Monitor,
  Presentation,
  Share2,
  Smartphone,
  Tablet,
  Watch,
} from "lucide-react";

export function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { formaDesktop?: unknown }).formaDesktop)
  );
}

export function saveStateCopy(saved: boolean, isDesktop = isDesktopRuntime()) {
  const destination = isDesktop ? "已保存到本机" : "已保存到此浏览器";
  return {
    title: saved ? destination : "保存中",
    tip: saved ? destination : "正在保存…",
    desc: isDesktop
      ? "变更已自动保存在本机工作空间，随时可导出 .forma.json 备份"
      : "变更已自动保存在当前浏览器中，换设备前可下载设计源文件",
    shortStatus: saved ? "已保存" : "保存中",
  };
}

export function storageUnavailableCopy(isDesktop = isDesktopRuntime()) {
  return isDesktop
    ? "本机工作空间暂时无法保存项目分组"
    : "当前浏览器暂时无法保存项目分组";
}

export const WELCOME_FRAME_PRESETS = {
  mobile: { label: "iPhone 16", w: 393, h: 852 },
  desktop: { label: "Desktop 1440×900", w: 1440, h: 900 },
} as const;

export const UNIFIED_FRAME_PRESET_GROUPS = [
  {
    id: "phone",
    label: "手机",
    icon: Smartphone,
    defaultOpen: true,
    items: [
      WELCOME_FRAME_PRESETS.mobile,
      { label: "iPhone 16 Pro", w: 402, h: 874 },
      { label: "iPhone 16 Pro Max", w: 440, h: 956 },
      { label: "iPhone 13 / 14", w: 390, h: 844 },
      { label: "Android 紧凑屏", w: 412, h: 917 },
    ],
  },
  {
    id: "tablet",
    label: "平板",
    icon: Tablet,
    defaultOpen: false,
    items: [
      { label: 'iPad Pro 11"', w: 834, h: 1194 },
      { label: "iPad 横屏", w: 1024, h: 768 },
      { label: "iPad Mini", w: 744, h: 1133 },
    ],
  },
  {
    id: "desktop",
    label: "桌面端",
    icon: Monitor,
    defaultOpen: false,
    items: [
      { label: "Desktop 1440×1024", w: 1440, h: 1024 },
      WELCOME_FRAME_PRESETS.desktop,
      { label: 'MacBook Pro 14"', w: 1512, h: 982 },
      { label: "营销落地页", w: 1440, h: 1024 },
    ],
  },
  {
    id: "presentation",
    label: "演示文稿",
    icon: Presentation,
    defaultOpen: false,
    items: [
      { label: "16:9 宽屏", w: 1920, h: 1080 },
      { label: "4:3 标准", w: 1024, h: 768 },
    ],
  },
  {
    id: "watch",
    label: "智能手表",
    icon: Watch,
    defaultOpen: false,
    items: [
      { label: "Apple Watch 45mm", w: 198, h: 242 },
      { label: "Apple Watch Ultra", w: 205, h: 251 },
    ],
  },
  {
    id: "paper",
    label: "打印纸张",
    icon: FileText,
    defaultOpen: false,
    items: [
      { label: "A4", w: 595, h: 842 },
      { label: "Letter", w: 612, h: 792 },
    ],
  },
  {
    id: "social",
    label: "社交媒体",
    icon: Share2,
    defaultOpen: false,
    items: [
      { label: "方形封面", w: 1080, h: 1080 },
      { label: "横幅头图", w: 1500, h: 500 },
      { label: "分享卡片 OG", w: 1200, h: 630 },
    ],
  },
] as const;
