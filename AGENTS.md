# AGENTS.md

PenMods 桌面安装器：有道词典笔 PenMods 的一键安装器。Electron 外壳 + Vite/React 渲染层 + 本地 HTTP/WS 服务（默认 `127.0.0.1:47821`，被占用时随机端口）。

## Commands

All commands run from `app/`.

- `npm run dev` — Vite dev server + Electron
- `npm run build` — `vite build`（只打包渲染层，**不含** `tsc -b`）
- `npm run typecheck` — `tsc -b`，Electron 主进程与渲染层的类型检查都走这个
- `npm run dist` — `vite build` + electron-builder（Windows NSIS + portable）

单测在 `app/src/**/__tests__/*.test.ts`（vitest，node 环境），但 **vitest 不在 devDependencies 里**，
也没有 `npm test` 脚本 —— 跑测试要先 `npm i -D vitest`；CI 目前只跑 typecheck + build。

## Conventions

- 渲染层代码在 `app/src/`，主进程代码在 `app/electron/`（CommonJS `.cjs`）。改主进程要同步考虑 `preload.cjs` 暴露的接口。
- 本地服务（`app/electron/server.cjs`）只监听回环地址；任何新增代理端点都必须有目标域名白名单。
- 不改 `app/public/files/` 下的大体积二进制内容，除非用户明确要求。
- 注释和 UI 文案用中文，与现有代码一致。

## Agent skills

### Issue tracker

Issues live as GitHub issues on `Zikuishanlu/PenModsInstaller-Desktop`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to labels of the same name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
