# pnpm Monorepo 最小骨架设计

## 目标

在当前空目录创建一个由 pnpm workspace 管理的最小 monorepo。仓库只提供根级工作区配置和 `packages/*` 包目录，不引入应用框架、示例业务包或第三方工程化工具。

## 范围

本次创建以下内容：

- 初始化 Git 仓库。
- 创建私有根包，防止根目录被误发布。
- 使用 `pnpm-workspace.yaml` 将 `packages/*` 声明为工作区成员。
- 在根包提供递归执行 `build`、`test` 和 `lint` 的脚本；子包没有对应脚本时不报错。
- 创建空的 `packages/` 目录，并使用占位文件使其能被 Git 跟踪。
- 提供简短 README 和适用于 Node.js/pnpm 项目的 `.gitignore`。
- 生成共享的 `pnpm-lock.yaml`，验证依赖安装和 workspace 配置可用。

不在本次范围内：

- 示例 package 或应用。
- TypeScript、ESLint、Prettier、Changesets、Turborepo 等工具。
- CI、发布流程或远程 Git 仓库配置。

## 目录结构

```text
.
├── .gitignore
├── README.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── packages/
    └── .gitkeep
```

## 根配置

`package.json` 将：

- 使用当前目录名 `ai-devflow` 作为根包名。
- 设置 `private: true`。
- 通过 `packageManager` 记录环境中实际使用的 pnpm 版本。
- 定义 `build`、`test`、`lint` 根脚本，使用 pnpm 递归执行子包中的同名脚本，并忽略尚未定义的脚本。

`pnpm-workspace.yaml` 只匹配 `packages/*`。未来新增包时，每个一级子目录都应包含自己的 `package.json`，包之间使用 `workspace:*` 声明内部依赖。

## 依赖与命令流

开发者在根目录运行 `pnpm install`。pnpm 读取 workspace 配置，为所有成员统一解析依赖，并将结果记录到根目录的 `pnpm-lock.yaml`。根命令再通过 pnpm 的递归执行能力分发到各子包。

由于初始状态没有实际子包，安装应当不下载第三方依赖；递归脚本也应当正常结束。添加首个包后，无需修改根 workspace 配置。

## 错误处理

- 根包设为私有，避免误执行发布。
- 根脚本允许子包暂缺同名脚本，适合渐进式添加包。
- `node_modules`、构建输出、日志和环境变量文件进入 `.gitignore`。
- pnpm 不可用时，验证步骤明确失败并提示先启用或安装 pnpm；不会静默改用 npm 或 yarn。

## 验证标准

完成后应满足：

1. `pnpm install` 成功并生成根锁文件。
2. pnpm 能识别根 workspace 配置，且没有配置格式错误。
3. `pnpm build`、`pnpm test`、`pnpm lint` 在尚无子包时均能成功退出。
4. Git 状态中只包含预期的项目骨架文件。

