// 主题皮肤与布局定义（纯数据，不依赖 Vue / Pinia / 平台代码）。
// 皮肤只覆盖强调色等变量，深/浅色明暗由既有 data-theme 体系承担；
// 布局控制 Dashboard 的排布与信息密度。

export const SKINS = [
  {
    id: "blue",
    name: "经典蓝",
    desc: "沉稳专业，默认风格",
    preview: ["#087fc4", "#45b6ff"],
  },
  {
    id: "aurora",
    name: "极光绿",
    desc: "清新通透的绿松色调",
    preview: ["#0e9f6e", "#34d399"],
  },
  {
    id: "sunset",
    name: "暖阳橙",
    desc: "温暖有活力的橙色",
    preview: ["#d97706", "#fbbf24"],
  },
  {
    id: "violet",
    name: "紫罗兰",
    desc: "神秘优雅的紫色",
    preview: ["#7c3aed", "#a78bfa"],
  },
  {
    id: "rose",
    name: "玫瑰红",
    desc: "热情醒目的玫红",
    preview: ["#e11d48", "#fb7185"],
  },
  {
    id: "ocean",
    name: "海洋蓝",
    desc: "深邃清冷的青蓝",
    preview: ["#0d9488", "#2dd4bf"],
  },
];

export const LAYOUTS = [
  {
    id: "classic",
    name: "经典",
    desc: "当前呼叫 + 收藏中继 + 最近通联的默认排布",
    preview: "classic",
  },
  {
    id: "minimal",
    name: "极简",
    desc: "收起侧栏与次要工具，突出当前呼叫与通联列表",
    preview: "minimal",
  },
  {
    id: "cockpit",
    name: "驾驶舱",
    desc: "大字号、高对比、大按钮，适合值守与车载",
    preview: "cockpit",
  },
  {
    id: "immersive",
    name: "大屏看板",
    desc: "沉浸式信息看板，隐藏操作元素，适合壁挂大屏",
    preview: "immersive",
  },
];

export const DEFAULT_SKIN = "blue";
export const DEFAULT_LAYOUT = "classic";
export const THEME_KEY = "fmo_theme";
export const SKIN_KEY = "fmo_skin";
export const LAYOUT_KEY = "fmo_layout";
