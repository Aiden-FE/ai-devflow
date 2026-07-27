---
name: web-design-engineer
description: 构建/重构浏览器渲染的可视产物（页面/仪表盘/原型/动效/数据可视化）。本 SKILL 是 Pi 运行时内置 web-design-engineer 技能的精简指针，运行时由 Pi 解析内置同名技能
---

# web-design-engineer

> 本文件是 ai-devflow 仓库内的精简指针。Pi 运行时自带同名重技能 `web-design-engineer`（位于 `~/.pi/agent/skills/web-design-engineer`），UX专家通过 `--skill` 显式加载。如运行时缺少该内置技能，回退到本精简版要点。

## When to Use
UX专家需要把 UX 建议具体化为可渲染的前端产物（页面、组件、原型、动效、数据可视化）时。

## Procedure
1. 明确产物形态与承载（单页 HTML / React 组件 / 仪表盘）。
2. 以结构化 UX 规格（交互/视觉结构/可访问性/响应式）为输入。
3. 产出可独立渲染、可访问性达标、响应式的代码或原型。
4. 自检：键盘可达、对比度、断点适配、空/错/载态。

## Pitfalls
- 产物无法独立渲染（依赖未声明的运行时）。
- 忽略可访问性与响应式。

## 参考
- Pi 内置 `web-design-engineer` 技能为权威来源；本文件仅保证 ai-devflow 物化快照内有 SKILL.md 占位以通过 `BUILTIN_SKILLS` 校验。
