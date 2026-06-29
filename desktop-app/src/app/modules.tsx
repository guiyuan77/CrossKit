import type { ComponentType } from "react";
import { Film, ScanSearch, Settings, Sparkles } from "lucide-react";
import TranscodePage from "../features/transcode/TranscodePage";
import TemplatePage from "../features/_template/TemplatePage";
import SettingsPage from "../features/settings/SettingsPage";
import DeconstructorPage from "../features/deconstructor/DeconstructorPage";

/*
  功能模块注册中心 + 功能开关（feature flag）。
  ── 新增一个功能就在这个数组里加一项，并写一个页面组件即可，侧边栏会自动出现。
  字段说明：
    id        唯一标识（路由用）
    label     侧边栏显示名
    icon      lucide 图标组件
    component 页面组件
    group     分组：main = 主功能区，bottom = 底部（设置等）
    enabled   功能开关：不写或 true = 显示；false = 隐藏（代码保留，用户看不到）

  ★ 回退/试错三板斧（详见根目录 PROJECT_STATUS.md「加/删功能模块 SOP」）：
    1) 想临时下线某功能：把它的 enabled 改成 false（最轻，秒级，代码不动）。
    2) 想保留历史地移除：git revert 该功能的提交。
    3) 想彻底删除：删 features/<功能>/ 目录 + 删 lib.rs 里的命令注册行 + 删本数组对应项。
*/
export interface AppModule {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  component: ComponentType;
  group?: "main" | "bottom";
  /** 功能开关：不写或 true = 显示；false = 隐藏（代码保留） */
  enabled?: boolean;
}

export const modules: AppModule[] = [
  {
    id: "transcode",
    label: "视频批量转换",
    icon: Film,
    component: TranscodePage,
    group: "main",
    enabled: true, // 稳定核心功能
  },
  // 对标拆解器（P1 · 阶段A）：内测中已开启，发布前如需隐藏改回 enabled:false。
  {
    id: "deconstructor",
    label: "对标拆解器",
    icon: ScanSearch,
    component: DeconstructorPage,
    group: "main",
    enabled: true,
  },
  // 这是新功能的示例模板，复制它改名即可新增功能。默认隐藏（发布给用户时不展示演示页）。
  {
    id: "template",
    label: "新功能模板",
    icon: Sparkles,
    component: TemplatePage,
    group: "main",
    enabled: false,
  },
  {
    id: "settings",
    label: "设置",
    icon: Settings,
    component: SettingsPage,
    group: "bottom",
    enabled: true,
  },
];

/** 仅启用的模块（enabled !== false）。侧边栏与路由都应使用它。 */
export const visibleModules: AppModule[] = modules.filter((m) => m.enabled !== false);
