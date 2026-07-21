// Agent 能力配置的「全局默认 + 项目覆盖」逐字段合并（纯函数，零依赖）。
//
// 合并顺序：项目显式值 > 全局值 > 系统默认（defaultAgentForRole / 适配器默认，由调用方叠加）。
// 关键语义：undefined = 未配置（继承上一层）；[] / false 等 = 显式覆盖值（会覆盖继承值）。
// 因此「打开并保存表单」不会把继承值固化为项目值——只要表单把继承字段表示为 undefined 即可。
import type { GlobalAgentConfig, RoleAgentConfig, TaskRole } from './types.js';

/** 参与合并的能力字段（agentType 也在内，便于 UI 一并展示继承来源）。 */
export const ROLE_CONFIG_FIELDS: (keyof RoleAgentConfig)[] = [
  'agentType',
  'plugins',
  'skills',
  'tools',
  'disallowedTools',
  'requireApproval',
];

export interface ResolvedRoleConfig {
  /** 合并后的最终配置（项目显式值 > 全局值）。 */
  config: RoleAgentConfig;
  /** 每个字段是否来自项目覆盖（true=项目显式值；false=继承全局或未配置）。 */
  overridden: Partial<Record<keyof RoleAgentConfig, boolean>>;
}

/** 逐字段合并：project 显式值（!== undefined，含 []）覆盖 global；否则继承 global。 */
export function mergeRoleConfig(
  global?: RoleAgentConfig,
  project?: RoleAgentConfig,
): RoleAgentConfig {
  return resolveRoleConfig(global, project).config;
}

/** 逐字段合并并标注每个字段的来源（项目覆盖 / 继承全局）。 */
export function resolveRoleConfig(
  global?: RoleAgentConfig,
  project?: RoleAgentConfig,
): ResolvedRoleConfig {
  const config = {} as Record<string, unknown>;
  const overridden: Partial<Record<keyof RoleAgentConfig, boolean>> = {};
  for (const f of ROLE_CONFIG_FIELDS) {
    const pv = project?.[f];
    const gv = global?.[f];
    if (pv !== undefined) {
      config[f] = pv;
      overridden[f] = true; // 项目显式覆盖
    } else if (gv !== undefined) {
      config[f] = gv;
      overridden[f] = false; // 继承全局
    } else {
      overridden[f] = false; // 均未配置（交由系统默认）
    }
  }
  return { config: config as RoleAgentConfig, overridden };
}

/** 便捷：从全局配置 + 项目 roleConfigs 解析某一角色的合并配置与来源。 */
export function resolveRoleConfigForRole(
  role: TaskRole,
  global?: GlobalAgentConfig,
  projectRoleConfigs?: GlobalAgentConfig,
): ResolvedRoleConfig {
  return resolveRoleConfig(global?.[role], projectRoleConfigs?.[role]);
}

/**
 * 从合并后的项目 roleConfigs 中剔除「与全局完全一致」的字段，得到仅含真实覆盖的精简配置。
 * 用于保存时避免把继承值固化为项目值（保持 undefined=继承）。
 */
export function stripInheritedFields(
  global?: RoleAgentConfig,
  project?: RoleAgentConfig,
): RoleAgentConfig {
  const out = {} as Record<string, unknown>;
  for (const f of ROLE_CONFIG_FIELDS) {
    const pv = project?.[f];
    if (pv === undefined) continue; // 未配置，无需写入
    const gv = global?.[f];
    // 与全局深等（数组按 JSON 比较）则视为继承，不写入项目配置。
    if (gv !== undefined && JSON.stringify(gv) === JSON.stringify(pv)) continue;
    out[f] = pv;
  }
  return out as RoleAgentConfig;
}
