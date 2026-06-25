import type { ComponentType } from "react";
import { Film, Settings, Sparkles } from "lucide-react";
import TranscodePage from "../features/transcode/TranscodePage";
import TemplatePage from "../features/_template/TemplatePage";
import SettingsPage from "../features/settings/SettingsPage";

/*
  功能模块注册中心。
  ── 新增一个功能就在这个数组里加一项，并写一个页面组件即可，侧边栏会自动出现。
  字段说明：
    id        唯一标识（路由用）
    label     侧边栏显示名
    icon      lucide 图标组件
    component 页面组件
    group     分组：main = 主功能区，bottom = 底部（设置等）
*/
export interface AppModule {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  component: ComponentType;
  group?: "main" | "bottom";
}

export const modules: AppModule[] = [
  {
    id: "transcode",
    label: "视频批量转换",
    icon: Film,
    component: TranscodePage,
    group: "main",
  },
  // 这是新功能的示例模板，复制它改名即可新增功能：
  {
    id: "template",
    label: "新功能模板",
    icon: Sparkles,
    component: TemplatePage,
    group: "main",
  },
  {
    id: "settings",
    label: "设置",
    icon: Settings,
    component: SettingsPage,
    group: "bottom",
  },
];
