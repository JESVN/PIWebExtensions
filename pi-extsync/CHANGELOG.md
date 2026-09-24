# Changelog

本项目遵循「一个版本一段说明」的简记法；类型用 `新增 / 修复 / 变更 / 文档 / 内部`。

## 0.1.0 — 2026-09-24

### 新增

- 核心引擎 `tools/pi-sync.mjs`：把仓库里声明了 `pi.extensions` 的扩展按文件软链到
  `<agent-dir>/extensions/`，并清理仓库中已删除的残留软链；支持 `sync` / `pull` / `uninstall` / `status`
  四个命令与 `--dry-run` / `--force` / `--json` / `--repo` / `--agent-dir` 选项。
- 扩展 `pi-extsync`：斜杠命令 `/extsync`（不带参数弹菜单）与工具 `ext_sync`
  （`action` + `dryRun`），结果以自定义消息落到聊天区。
- 安全边界：只管理「软链 + 解析后落在本仓库内」的条目；真实文件占用只报冲突不覆盖；
  `git pull` 仅 `--ff-only` 且工作区脏就跳过；不写任何配置文件、不重启任何进程。
- 文案消歧：扩展是全局安装的，但同步对象永远是「本扩展所在仓库」而非当前工作目录所在项目。
  因此 `/extsync` 与 `ext_sync` 的描述、确认文案、菜单标题都点名仓库名，结果卡片首行标明
  `同步对象：<仓库路径>（与当前工作目录无关）`。
- 冒烟测试 `test/smoke.mjs`：临时仓库 + 临时 agent 目录 + 内核 loader + 真实 fork 引擎，
  覆盖引擎与扩展壳共 19 个场景，全离线。

### 背景

pi 从 `<agent-dir>/extensions/` 加载扩展，而本仓库是「一个子目录 = 一个扩展」的 monorepo。
手写软链在多机之间容易漏装、残留悬空链，也没有统一的卸载入口。

### 已知限制

- 仅 Linux / macOS（Windows 建软链需额外权限）。
- 扩展壳依赖仓库里的 `tools/pi-sync.mjs`（可用 `PI_SYNC_BIN` 覆盖），不适合单独发布到 npm。
- 同一扩展不要既软链又 `pi install`，否则工具会重复注册。
