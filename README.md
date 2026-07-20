# ai-devflow

使用 pnpm workspace 管理的最小 monorepo。

## 环境要求

- Node.js
- pnpm 11.11.0

## 安装

```bash
pnpm install
```

## 目录

- `packages/*`：工作区包

每个包需要自己的 `package.json`。工作区内部依赖使用 `workspace:*` 协议声明。

## 命令

```bash
pnpm build
pnpm test
pnpm lint
```

根命令会递归执行各包中已定义的同名脚本。
