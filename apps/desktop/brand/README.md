# ai-devflow 品牌标识

## 母稿记录

4 张候选由本机 Comfy Desktop 的 story-frame（http://127.0.0.1:8188）生成：

- seed：`8726174021364`
- prompt_id：`01f5e79c-2b85-4a9c-bf1a-52ce0140a3e9`
- 候选路径：`/Users/aiden/ComfyUI-Shared/output/ai-devflow/logo-concept_0000{1..4}_.png`
- 选定：`logo-concept_00001_.png`
- 选择理由：几何平衡、16px 仍保持强轮廓；右半圆环 + 左侧尖角自然融合“连续流转环 + 代码括号”，四节点表达智能节点；原创性高，不近似现有厂商商标。

> AI 图仅作母稿，本目录 SVG 为手工重建的真实矢量源，未嵌入 PNG。

## 标识语义

- 右侧半圆环：AI 任务/代码的持续流转与循环。
- 左侧尖角「<」： subtly 代码括号，点题“开发”。
- 四节点：流程中的智能节点；紫罗兰节点为克制点缀色。
- 配色：电光蓝 `#2f6bff` / 青色 `#22d3ee` 为主，紫罗兰 `#7c5cff` 点缀。

## 文件清单

| 文件 | 说明 |
|------|------|
| `icon.svg` | 容器版主源（品牌渐变圆角方底 + 白色标识），用于生成 PNG/ICNS/ICO |
| `mark.svg` | 独立标识，透明底彩色，用于侧边栏/浅色界面 |
| `mark-mono.svg` | 单色版（`currentColor`），可继承父级颜色 |
| `light.svg` | 浅底容器版 |
| `dark.svg` | 深底容器版 |
| `lockup.svg` | 横版：图标 + `ai-devflow` 文字（彩色） |
| `lockup-mono.svg` | 横版单色版 |

## 重新生成栅格资产

```bash
node apps/desktop/scripts/gen-brand-assets.mjs
```

脚本优先使用跨平台 `@resvg/resvg-js`；本机发布环境已退回到 macOS `qlmanage` + `sips`，并用纯 Node 写入 ICO/ICNS，产物位于 `apps/desktop/build/`。
