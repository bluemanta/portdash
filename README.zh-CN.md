# PortDash

本地开发服务的可视化控制台。零依赖单文件，只用 Node 自带模块。

[English](README.md)

## 运行

```bash
npx @bluemanta/portdash
```

或者克隆下来直接跑：

```bash
git clone https://github.com/bluemanta/portdash.git
cd portdash
node portdash.js
```

然后打开 http://localhost:7777

也可以在访达里双击 `启动PortDash.command`。

## 让看门狗常驻（可选）

看门狗只在 PortDash 运行时才起作用。关掉它，你的 dev server 会继续跑——但没人看着。想让它常驻后台：

```bash
npm install -g @bluemanta/portdash
portdash --install-agent
```

这会装一个 macOS LaunchAgent，开机自启、异常退出后自动重启。它**以你自己的身份运行，不是 root**——发信号给你的进程需要同一个用户，而 root 的权限远超它的实际需要。卸载用 `portdash --uninstall-agent`。

两个需要知道的坑：

- 它会记下安装时那个 `node` 的路径。如果那是 nvm 管的版本，之后你把该版本删了，agent 就废了——重装一次，或者指向一个稳定的 Node。
- **被冻住的服务是安静的。** SIGSTOP 之后进程不崩溃、不报错，只是不响应，如果你忘了后台有东西在管着会很困惑。服务无缘无故没反应时，去看 `~/.portdash/portdash.log`。

## macOS 权限（完全磁盘访问、照片、通讯录……）

如果一个服务你在终端里跑得好好的，通过 PortDash 启动却报 `Operation not permitted`，原因在这里。

macOS 把隐私权限授予**责任进程**——也就是启动链最顶端的那个 App，而不是真正干活的那个二进制。子进程继承这个身份。进程被 detach、自成进程组**不会**切断继承，唯一起作用的是链顶是谁。

所以解法取决于 PortDash 自己是被谁启动的：

| PortDash 的启动方式 | 责任进程 | 怎么办 |
|---|---|---|
| Terminal.app / iTerm | 该终端 | 不用管——直接继承你已经授给终端的权限 |
| 别的 App（编辑器、AI agent、启动器） | 那个 App | 给那个 App 授权，或者改从终端启动 PortDash |
| `--install-agent` | `node` 二进制本身 | 直接给 `node` 授权 |

常驻 agent 模式下没有终端可继承，所以要授权给 Node 本身：
系统设置 → 隐私与安全性 → 完全磁盘访问权限 → `+` → <kbd>⌘⇧G</kbd> → 填 `which node` 的输出。

授权前需要权衡两点：

- 这等于给你机器上**所有** Node 程序都开了这个权限，不只是 PortDash。授权面比大多数人预期的宽，而 macOS 在这里没有更细的粒度。
- 用一个稳定的解释器路径。nvm、asdf 这类版本管理器每次升级都会换路径，授权不会跟着走。

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
| `token` | API 令牌，首次运行生成，权限 `0600` |
| `portdash.log` | PortDash 自己的输出，超过 2M 自动轮转 |
| `logs/` | 每个项目一个日志文件，启动时超过 5M 自动归档为 .old |

启动命令是扫描时从 `package.json` 的 scripts 猜的（dev > start > serve），猜错了在界面上点「编辑」改掉，之后不会被覆盖。

## 安全

这个 API 能拉起进程，所以做了三层限制：`Host` 头必须是本地（挡 DNS 重绑定）、跨站 `Origin` 一律拒绝、所有 `/api/` 请求必须带上 `~/.portdash/token` 里的令牌（放在 `X-Portdash-Token` 头里）。前两层挡的是网页，令牌挡的是**本机其他进程**——常驻之后这一层才是关键。

脚本调用的话：

```bash
curl -H "X-Portdash-Token: $(cat ~/.portdash/token)" http://localhost:7777/api/state
```

## 注意

- 关掉 PortDash 不会影响已经启动的服务，它们继续在后台跑；重开会重新认领它们
- 看门狗只自动处置 PortDash 自己启动的进程，不会去动你手动跑的东西
- pid 会被系统回收，所以一条记录只有在占用该 pid 的进程「年龄不小于记录本身」时才被信任，否则宁可丢弃，也不冒险对陌生进程发信号
- 端口被占时它会等待重试而不是退出，而且只有抢到端口之后才启动看门狗，所以第二个实例不会和第一个抢着管同一批进程
- 界面只监听 127.0.0.1，不对局域网开放
