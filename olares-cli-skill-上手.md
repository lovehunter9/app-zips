# olares-cli + olares-skills 上手(安装 · 部署 · 使用)

> 一句话:`olares-cli` 是一个命令行**遥控器**(单个二进制),`olares-skills` 是给 AI agent(Cursor/Claude 等)看的**说明书**。
> 二者都跑在**你本地电脑**上;真正的安装应用、跑容器、模型推理/GPU 都在**远端那台 Olares 机器**上。本地只是驾驶座。

---

## 0. 前置

- 一台已装好 Olares OS 的机器 + 你的 Olares ID(形如 `name@xxx.olares.com`,或自定义域名)。
- 本地有 `node` / `npx`(任意装一种 Node 即可)。
- 仅"本地源码编译"路线需要:`git` + Go(无所谓版本,`GOTOOLCHAIN=auto` 会自动拉所需版本)。

---

## 1. 安装 olares-cli

二选一。

### 路线 A:npm 一键(推荐给大多数人)

```bash
npx @olares/cli@latest install
```

它做两件事:`npm install -g @olares/cli`(把 `olares-cli` 装上 PATH)+ `npx skills add beclab/Olares -y -g`(装 6 个官方 skills)。**不装 Olares OS、不自动登录**。

### 路线 B:本地源码编译(老板要求这条 / 想要最新)

```bash
# 需要整仓(cli/go.mod 有相对 replace ../framework/oac,只克隆 cli/ 编不过)
git clone https://github.com/beclab/Olares.git ~/beclab/Olares
cd ~/beclab/Olares/cli
go build -o olares-cli ./cmd/main.go          # GOTOOLCHAIN=auto 会自动下载所需 Go 工具链

# 放进 PATH(macOS Apple Silicon,/opt/homebrew/bin 已在 PATH、且免 sudo)
ln -sf "$(pwd)/olares-cli" /opt/homebrew/bin/olares-cli
olares-cli --version                          # 源码编译显示 0.0.0-development 属正常
```

---

## 2. 登录(把遥控器连到那台 Olares)

**这步必须你本人做**(要输密码/2FA,不能交给 AI)。

```bash
olares-cli profile login --olares-id <你的Olares-ID>
# 按提示输密码(不回显是正常的);开了 2FA 再输验证码

olares-cli profile whoami      # 看身份/角色
olares-cli profile list        # 看所有 profile、当前用哪个、后端版本
```

> 注意:**没有** `profile current` 这个子命令;查状态用 `whoami` / `list`。
> token 存在系统钥匙串里;切换身份用 `olares-cli profile use <名字>`。

---

## 3. 安装 skills(让 AI agent 能"照着说明书"驱动)

路线 A 已经装过了。路线 B 或想用**本地仓库版**:

```bash
cd ~/beclab/Olares/cli
npx skills add "$(pwd)/skills" --skill '*' -a cursor -g -y   # -a 选 agent:cursor/claude-code/codex...
```

- 装到 `~/.agents/skills/olares-*`(跨 agent 标准位置)。
- **切忌加 sudo**(会产生 root 属主目录,以后重装报 EACCES)。
- 卸载:`npx skills remove beclab/Olares -y -g`。

> 在 Cursor 里**新开一个对话**后,这些 skills 才会自动进 AI 的技能清单。
> **怎么确认 AI 真在用 skill**:看它动手前有没有读 `~/.agents/skills/olares-*/SKILL.md`。

---

## 4. 怎么用

### 命令三层结构

```
olares-cli <area> [<noun>] <verb> [flags]
```

`--help` 永远是 flag 的权威来源:`olares-cli market --help`、`olares-cli cluster pod logs --help`。
几乎所有只读命令支持 `-o json`(给脚本/AI 解析);写操作默认要确认,脚本里加 `--yes`。

### 常用速查

```bash
# 市场 / 应用生命周期
olares-cli market list --mine                 # 我装了哪些 app
olares-cli market status <app> --watch        # 盯安装/运行状态到终态
olares-cli market install <app> --watch
olares-cli market clone <base> -s upload --env K=V --watch   # 克隆模板类 app

# 集群运行时(ControlHub)
olares-cli cluster pod list
olares-cli cluster pod logs <pod> -f          # 跟日志
olares-cli cluster application list

# chart 开发(本地,无需登录)
olares-cli chart from-compose --name <app> -f docker-compose.yml
olares-cli chart lint ./<app>
olares-cli chart package ./<app> -o ./dist
olares-cli market upload ./dist/<app>-<ver>.tgz   # 传到 source 'upload'

# 设置 / 文件 / 仪表盘
olares-cli settings apps list
olares-cli files ls /drive/Home
olares-cli dashboard overview gpu -o json
```

### 让 AI 帮你做事(典型话术)

- "把这个 repo / docker-compose 移植成 Olares app 并装上" → AI 走 `olares-chart`:from-compose → lint → package → upload → install → 看日志诊断。
- "在我的 Olares 上跑某个 HF 模型" → AI 走 `olares-chart` 的 llm-models:克隆 llm-init 基座 + 填 env。
- "看看 xxx 这个 pod 为什么挂了" → AI 走 `olares-cluster`:pod logs / events。

---

## 5. 排错速查

| 现象 | 处理 |
|---|---|
| `command not found: olares-cli` | 没进 PATH。检查 `which olares-cli`;源码编译记得做软链 |
| 编译报 `operation not permitted` 写 `~/go` | 在受限沙箱里跑;给足文件写权限或在普通终端跑 |
| 任意命令 401/403/459 | token 过期:`olares-cli profile login --olares-id <ID>` |
| `app 'X' is not installed` | 先 install,或核对 app 名 |
| 上传的 chart 装不上/看不到 | install/clone 记得带 `-s upload` |
| AI 没"用 skill" | 新开对话让 skills 自动加载;或让它先 Read `~/.agents/skills/olares-*/SKILL.md` |

---

## 6. 卸载

```bash
npm uninstall -g @olares/cli           # 路线 A 装的客户端
# 路线 B:删软链 + 删二进制即可
rm -f /opt/homebrew/bin/olares-cli
npx skills remove beclab/Olares -y -g  # 移除 skills
olares-cli profile remove <名字>        # 清除某身份的本地 token
```
