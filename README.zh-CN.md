# PortDash

本地开发服务的可视化控制台。零依赖单文件，只用 Node 自带模块。

[English](README.md)

## 运行

```bash
cd ~/Documents/CodeProjects/portdash
node portdash.js
```

然后打开 http://localhost:7777

也可以在访达里双击 `启动PortDash.command`。

## 它能做什么

- **看**：所有正在监听端口的进程，按项目归类；每个项目显示实时内存占用
- **控**：启动 / 暂停 / 恢复 / 重启 / 停止，信号发给整个进程组，`npm run dev` 派生的子进程一起收
- **暂停是真暂停**：SIGSTOP 挂起，进程冻在原地，内存和端口都保留，恢复（SIGCONT）是瞬间的
- **日志**：由 PortDash 启动的服务，输出记在 `~/.portdash/logs/`，界面上直接看
- **外部启动也认**：你在终端里手动跑的 dev server，只要工作目录对得上，也显示在对应项目下并可被停掉

## 内存保护（防止某个服务把整台机器拖死）

看门狗每 2 秒扫一次全系统进程表，五道闸门：

| 闸门 | 触发条件 | 动作 |
|---|---|---|
| Node 堆上限 | 启动时注入 `NODE_OPTIONS=--max-old-space-size` | 让 node 自己 OOM 退出，而不是吃光系统内存 |
| 单项目软上限 | 进程组内存 > `projectRssMB`（默认 4G） | SIGSTOP 冻结，保留现场，界面弹告警 |
| 单项目硬上限 | > `hardRssMB`（默认 10G） | 直接 SIGKILL，不再客气 |
| 系统水位 | 可用内存 < 12%，或 swap 用量 > 4G | 冻结当前最占内存的项目；如果元凶不是 PortDash 起的，只告警 |
| 启动闸门 | 内存已紧张 / 60 秒内同一项目启动超过 3 次 | 拒绝启动，提示先看日志 |

**冻结不是杀死**：进程还在，看完日志你可以「恢复」继续，或者「停止」收工。

阈值都在 `~/.portdash/config.json` 的 `limits` 里改，单个项目还能在界面上单独设。
嫌它管太宽就把 `limits.enabled` 设成 `false`。

## 配置

都在 `~/.portdash/` 下：

| 文件 | 作用 |
|---|---|
| `config.json` | 扫描目录 `scanRoots`、界面端口 `uiPort`、扫描深度 `scanDepth`、内存限额 `limits` |
| `projects.json` | 项目登记表。首次运行自动扫描生成，之后「重新扫描」只增不改 |
| `state.json` | PortDash 拉起的进程记录 |
| `logs/` | 每个项目一个日志文件，启动时超过 5M 自动归档为 .old |

启动命令是扫描时从 `package.json` 的 scripts 猜的（dev > start > serve），猜错了在界面上点「编辑」改掉，之后不会被覆盖。

## 注意

- 关掉 PortDash 不会影响已经启动的服务，它们继续在后台跑；重开会重新认领它们
- 看门狗只自动处置 PortDash 自己启动的进程，不会去动你手动跑的东西
- 界面只监听 127.0.0.1，不对局域网开放
