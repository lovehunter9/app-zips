# OpenCode 预装包内置化(fork 官方镜像)设计文档

> 状态：方案阶段（未改代码）
> 适用：Olares 应用 opencode，chart 1.0.12 / appVersion 1.14.19（当前镜像 `docker.io/beclab/anomalyco-opencode:1.14.19`）
> 记录日期：2026-06-05
> 关联需求：老板对"预装包导致初始化时间长、且受网络影响"不满，要求 fork 官方原始 Dockerfile，把我们的 PATCH 与预装包全部 bake 进镜像重打一份；用户主观只应感到"初始化变快、其余完全一样"。借此机会同步升级 opencode 与 OMO 到最新版。

---

## 0. 成功判据（验收口径）

- 把现在"运行时（init 容器）联网下载 + 构建"的全部产物，前移到**镜像构建期**。
- **用户无感**：环境变量控制行为、用户装包/删包/重启保留行为**逐项不变**；用户主观只感到"初始化变快、不再受网络影响"。
- 借机升级：opencode → **v1.15.13**、OMO 默认版 → **4.7.5**（以实时 npm latest 为准；早前网页搜到的旧版本号已过时）；**除这两项版本升级外，其余行为一律不动**。

---

## 1. 现在为什么慢（根因）

官方镜像本身极小（`ghcr.io/anomalyco/opencode`，Alpine + opencode musl 二进制 + libgcc/libstdc++/ripgrep，约 160MB）。**所有重活堆在运行时两个 init 容器里**（`opencode/templates/opencode.yaml`），首装 / 缓存失效时全部联网串行：

1. `apk add` 一大批基础包：`python3 py3-pip git curl wget bash openssh-client nodejs npm go rust cargo iproute2 zip unzip gzip bzip2 xz tar zstd`
2. 从 **GitHub** 下 glibc（sgerrand）+ libstdc++，并把 opencode 的 **musl 二进制换成 glibc 构建**（官方 issue #3876 / #14867 证实 musl 下会 segfault）
3. `npm install -g vite`
4. `npm install -g oh-my-opencode@<版本>`（OMO）
5. 把整个根文件系统 `cp -a` 快照进 hostPath `.pkg-root`

网络密集、串行、受 CDN/墙影响 → 慢。这是老板不满的根因。

---

## 2. 必须原样保留的两套机制（红线）

### 2.1 持久化 / 共享机制（绝不能动语义）
当前运行态（见 `opencode.yaml` 末尾 volumes + 各容器 volumeMounts）：

- hostPath `.pkg-root/{bin,sbin,usr,lib,lib64,etc/apk,etc/ssl,...}` 被**挂载覆盖**到 `opencode` 主容器与 `pkg-manager` sidecar 的 `/bin /sbin /usr /lib /lib64 ...`。
- 即：**运行时真正的根文件系统 = 这份 hostPath 快照，而非镜像自带层**。
- 由此带来三个被用户依赖的性质：
  1. **跨重启/升级持久**（hostPath 在宿主机，不勾"删数据"就一直在）；
  2. **两容器共享同一套 rootfs**（pkg-manager 用 apk 装的包，opencode 立即可见）；
  3. 用户包通过 `.user-packages` 清单 + 重启时 `restore_user_packages` 复原。

### 2.2 环境变量行为
- `OPENCODE_OMO`（bool）：是否加载 OMO 插件 —— 由 init-setup 的 python 脚本处理，与镜像无关。
- `OPENCODE_OMO_VERSION`（semver，默认升级后为 `4.7.5`）：装哪个 OMO 版本；改了自动重启重装。
- 域名：写进 `olares-baseline-instructions.md`（运行时按域名生成）。

> 核心结论：**持久化模型必须保留**。方案不是"把包塞进镜像就丢掉 hostPath"，而是"**把 hostPath 快照的来源，从『联网下载+构建』换成『从镜像本地拷贝』**"。

---

## 3. 采用架构 A：镜像内置全部 + init 改为「本地 seed 快照」

（已与需求方确认采用 A；overlayfs 的架构 B 作为后续优化，不做第一版。）

**一句话**：fork 官方 Dockerfile，把第 1 节那 5 步的产物全部 bake 进镜像标准路径；`init-packages` 不再 `apk/curl/npm`，改成**从镜像自带的 `/usr /lib ...` 本地 `cp -a` 进 `.pkg-root`**（或解包一个预烤 tar）。下游（pkg-manager、`.user-packages` 复原、OMO 版本检查、env 处理）**全部不动**。

- 本地磁盘拷贝是秒级、零网络；
- **重装场景**（镜像通常已在节点缓存）→ init 只剩本地拷贝 → 几秒。

### 备选架构 B（后续优化，不做第一版）
overlayfs：镜像做 lowerdir、hostPath 做 upperdir，用户包写进 upper。更快更省盘，但需 overlay 挂载权限、跨容器共享要重挂 upperdir，复杂度与行为漂移风险更高。

---

## 4. forked Dockerfile 要 bake 什么

基于 **opencode v1.15.13** 的官方 `packages/opencode/Dockerfile`（Alpine）往上叠层，**多架构构建 amd64 / arm64**：

| 项 | 说明 | 备注 |
|---|---|---|
| 基础 apk 包 | 第 1 节那一长串 | 直接 `apk add` 进镜像 |
| glibc + libstdc++（仅 x86_64）| sgerrand alpine-pkg-glibc + `/lib64` linker 软链 | arm64 沿用 musl，按 `TARGETARCH` 分支 |
| **glibc 版 opencode 二进制（v1.15.13）** | 替换官方 musl 版 | 解决 musl segfault；按 arch 选 |
| 删除 PEP668 `EXTERNALLY-MANAGED` | 让 venv/pip 正常 | bake |
| 全局 npm 工具 `vite` | | bake 到全局 node_modules |
| **默认 OMO `oh-my-opencode@4.7.5`** | 装到 opencode 插件 loader 实际读取的位置 | 见 §6；非默认版本仍走 npm 回退 |
| `pkg-install` 包装脚本 | 现 init-setup 运行时写，内容静态 | bake |
| `webstart` / `webstop` / `weblist` | 同上，静态 | bake |
| 静态 SKILL 文件（web-preview / system-admin）| 内容不含域名 | 可 bake |

**不 bake、仍运行时生成**（依赖用户域名/开关，且无网络成本）：
- `olares-baseline-instructions.md`（含域名）
- 全局 `opencode.json` 的 instructions / plugin 处理（受 `OPENCODE_OMO` 控制）
- workspace.json 历史残留清理（ROLE A 冻结逻辑）
- venv 创建（本地、快）

---

## 5. init 容器怎么改（行为对照）

| 阶段 | 现在 | 改后 | 用户可见差异 |
|---|---|---|---|
| init-setup 装 python | `apk add python3`（联网） | python 已 bake，直接跑脚本 | 更快；行为同 |
| init-packages 建快照 | apk+github+npm+`cp -a`（联网，分钟级） | 从镜像 `cp -a` / 解包预烤 tar 进 `.pkg-root`（本地，秒级） | **只快，不变** |
| marker / fingerprint | 含包列表、OC_VER、glibc 版本 | 改为绑定**镜像版本/digest**；`verify_cache` 保留并与 bake 内容同步 | 升级换镜像 → 自动重 seed |
| `restore_user_packages` | 读 `.user-packages` 逐个 apk 复原 | **不动** | 同（仅用户自己装的包仍需联网，与今天一致） |
| OMO 版本逻辑 `olares_run_omo` | 版本不符就 npm 重装 | **不动**：默认版命中 bake 直接跳过；用户改成别的版本→npm 回退 | 默认极快；非默认与今天一致 |
| pkg-manager sidecar | apk 队列装/删 + 写 `.user-packages` | **完全不动** | 装包/删包/持久化逐项一致 |

---

## 6. OMO 处理（保留旋钮版 —— 已确认）

策略：**保留 `OPENCODE_OMO_VERSION` 旋钮**。默认版烤进镜像（离线秒起），用户改成非默认版才联网装一次。与今天行为完全一致，用户无感。

### 6.1 让默认路径完全离线的做法（loader 路径已容器实测确认）

**已实测确认的 loader 机制**（在 `ghcr.io/anomalyco/opencode:latest` 容器内，`--network none` 断网复现）：

- opencode **不用全局 npm**，而是把每个声明的插件按 `opencode.json` 里 plugin 数组的**精确字符串**作为目录名，安装到 **`~/.cache/opencode/packages/<spec>/node_modules/`**。例：plugin 写 `oh-my-openagent@4.7.5` → 落到 `~/.cache/opencode/packages/oh-my-openagent@4.7.5/node_modules/`，里面是该包 + 全部依赖 + 平台二进制（`oh-my-openagent-linux-arm64-musl` 等）的完整树。
- 该 pkgdir **顶层没有 package.json / lockfile**，只有 `node_modules/`。opencode 判定"是否已安装"基本就是看这个目录在不在。
- **断网铁证**：把含缓存的容器 commit 成镜像，`docker run --network none` 跑 `opencode run`，debug 日志出现 `service=plugin path=oh-my-openagent@4.7.5 loading plugin`，**全程无任何 install/fetch/registry/download**；唯一报错是模型 API 因无网络失败（与插件无关）。

**因此 bake 落点与做法（已锁定，2026-06-05 修正）**：

> ⚠️ **关键修正**：OMO 缓存读取路径 `~/.cache/opencode/packages/` 即 `/home/opencode/.cache/...`，运行时 `/home/opencode` 被 **hostPath（appData）整体覆盖**在镜像之上。所以**把缓存烤进镜像的 `/home/opencode/.cache` 是无效的**——会被 hostPath 盖掉。必须套用与 `.pkg-root` 完全相同的「staging + init seed」模式。

1. **build 期烤到中立 staging 路径**：Dockerfile 里把 `oh-my-openagent@<默认版>/` 整棵缓存树固化到镜像的 **`/opt/olares-bake/opencode-cache/packages/`**（不在 `/home/opencode` 下，不会被 hostPath 覆盖）。拿法：build 阶段设临时 `HOME=/opt/olares-bake/ochome`，写一份 `opencode.json`（plugin 钉精确版），`timeout opencode run` 触发解析（插件 install 在启动早期完成，模型调用失败/超时无所谓），再把生成的 `packages/<spec>` 拷到 staging。
2. **init 首启 seed 进 appData**：`init-packages` 新增一步——若 `/home/opencode/.cache/opencode/packages/<spec>` 不存在则 `cp -a` 从 staging 拷入（带 marker，只做一次；与 `.pkg-root` 同机制）。**这是 chart 侧的对应改动，见 §9A。**
3. **plugin 项钉精确版本，逐字符匹配目录名**：`opencode.json` 的 plugin 项写成 `oh-my-openagent@<默认版>`（不再用裸名），与 staging/seed 的目录名完全一致 → 命中、零联网。
4. **env 覆盖仍是唯一联网特例**：用户把 `OPENCODE_OMO_VERSION` 改成非默认版 → spec 串变 → seed 不命中 + opencode cache miss → opencode 自己联网拉那一版（与今天同一条回退语义）。

> 平台二进制随架构不同（`...-linux-arm64-musl` vs `...-x64-musl`），多架构镜像各自 bake 对应架构的缓存树即可（amd64 / arm64 分别 build 时，opencode 在对应架构上解析出正确二进制；buildx 下 arm64 stage 走 QEMU 模拟，见 §8 风险）。

### 6.2 包名问题 —— 已查清，不是 bug
OMO 项目改名 `oh-my-opencode` → `oh-my-openagent`，**双名发布**：
- npm 包名 + CLI 二进制**仍叫 `oh-my-opencode`**（同时也以 `oh-my-openagent` 发布）；
- `opencode.json` 插件项**官方现在推荐写 `oh-my-openagent`**，旧 `oh-my-opencode` 项仍能加载但带 warning。

我们现状（装 `oh-my-opencode` + plugin 数组写 `oh-my-openagent` + 删旧 stale 项）**正是官方文档的迁移姿势，是对的**。
- 可选清理：bake 4.7.5 时直接用 `oh-my-openagent` 新名以消掉 legacy warning。**按"别的不能动"默认保持现状双名处理**，是否顺手清 warning 待定。

### 6.3 现状的一处不一致（顺手理顺，仍属 OMO 升级范围）
当前 init 里有两条 OMO 相关路径其实**对不齐**：
- python 写进 `opencode.json` 的 plugin 项是**裸名 `oh-my-openagent`**（无版本 → opencode 解析 latest 并缓存，谁先跑谁定版，非确定性）；
- init-packages 的 `olares_run_omo` 则 `npm install -g oh-my-opencode@$OMO_VER` 装到全局 node_modules。

二者**名字不同、版本来源不同**：`OPENCODE_OMO_VERSION` 旋钮今天只影响那个全局 npm 安装，而**真正被 opencode loader 加载的是裸名那条（跟随 latest）**——旋钮未必真正决定了被加载的插件版本。改为「钉精确版本 `oh-my-openagent@<OMO_VER>` + 缓存 seed」后，旋钮才名副其实。**这属于在 OMO 升级范围内顺手修正，不算"动别的行为"**；全局 npm 那条 vestigial 安装可保留也可去除（见 §9A 决策点）。

---

## 7. 升级牵动的版本字段（升级必然同步，不算"动行为"）

> **版本已定（2026-06-05 拍板）：opencode 钉 v1.16.0**（6/5 当天发布的 latest），**OMO 默认 4.7.5**。

- `Chart.yaml`：`appVersion` 1.14.19 → **1.16.0**
- `OlaresManifest.yaml`：`spec.versionName` 同步 1.16.0；`OPENCODE_OMO_VERSION` 默认 3.17.4 → **4.7.5**（描述里示例版本号顺带更新）
- `opencode.yaml` 顶部 / init `OMO_VER` 默认 → **4.7.5**
- forked Dockerfile：不"继承"官方 18 行 Dockerfile（它 `COPY dist/...` 用 CI 自产二进制，我们没有），而是**重写**：二进制从 GitHub release 自取（x86_64 取 `opencode-linux-x64.tar.gz` glibc 版；arm64 取 `opencode-linux-arm64-musl.tar.gz`），版本钉 v1.16.0
- `init-packages` 里 `OC_VER="1.14.19"` → **1.16.0**（bake 后从"决定下载哪版"退化为对版校验 / marker 用途）

---

## 8. 风险与开放问题（动手前要定/要验）

1. ~~opencode 最新版本号待最终确认~~ **已定 v1.16.0**（6/5 当天发布的 latest stable）。release 资产确认：x86_64 用 `opencode-linux-x64.tar.gz`(glibc)，arm64 用 `opencode-linux-arm64-musl.tar.gz`(musl)。
2. ~~OMO 3.x→4.x 配置兼容性~~ **已验证通过（见 §12）**：schema 向后兼容，我们用的 `agents/categories/runtime_fallback` + 每项的 `model/variant/fallback_models` 在 4.7.5 全部仍合法。**不构成"别的不能动"的例外。**
3. ~~opencode 插件 loader 的真实读取路径~~ **已容器实测确认（见 §6.1 / §12）**：读 `~/.cache/opencode/packages/<plugin-spec>/node_modules/`，按 plugin 数组字符串逐字符建目录；断网下直接 `loading plugin`、零联网。bake 落点已锁定。**不再是开放项。**
4. ~~OMO 用 npm 装是否 OK~~ **已验证通过（见 §12）**：`npm install -g --ignore-scripts oh-my-opencode@4.7.5` 干净落地。官方虽建议 Bun，但 npm 这条路通，按"别的不能动"保持 npm。
5. **node 版本要求**：OMO 4.7.5 传递依赖（如 `toml@4.1.1`）要求 `node>=20`。forked Dockerfile 已加 **build 期断言** `node -e 'process.exit(node>=20?0:1)'`——若 Alpine 当前 `nodejs` < 20，构建会直接失败提示，不会静默出问题。
6. **多架构**：glibc 替换只对 x86_64；arm64 分支按 `TARGETARCH` 处理，二进制选对。
7. **apk DB 一致性**：seed 时必须连 `/etc/apk`（arch/repositories/world/installed DB）一起拷，否则用户后续 `apk add/del` 解析依赖会错。现快照已拷，保留。
8. **bash 每次重装的兜底**：现 pkg-manager 每次启动 `apk del bash && apk add bash`（glibc 级联修复）。bake glibc 后大概率可去掉，需实测确认。
9. **fork 维护成本**：opencode 升版本时 forked Dockerfile 要 rebase；`OPENCODE_OMO_VERSION` 默认值与 bake 的 OMO 要同步。

---

## 9. 逐项"用户无感"验证清单（回归用）

- **装包**：`pkg-install foo` → pkg-manager apk 装进共享 hostPath + 记 `.user-packages` → opencode 立即可见、重启保留。
- **删包**：`pkg-install --remove foo` → apk del + 从清单移除。
- **改 `OPENCODE_OMO`**：插件加载与否由 python 控制。
- **改 `OPENCODE_OMO_VERSION`**：默认值（4.7.5）命中 bake → 秒起；非默认 → npm 回退装。
- **升级镜像**：marker 失配 → `rm -rf .pkg-root` 重 seed（本地）→ `.user-packages` 复原 → workspace/config 不动。
- **重装应用（残留旧快照）**：新镜像 digest 不同 → 重 seed，覆盖旧快照（顺带缓解重装起不来的工单）。

---

## 9A. chart 侧需要的对应改动（配合 forked 镜像，下一步实施）

> forked 镜像已产出：`opencode-docker/{Dockerfile,build.sh,README.md}`。镜像只把可烤的东西放到 **`/opt/olares-bake/`**（中立、不被 hostPath 覆盖）。要让运行时真正用上，chart 的 init 需做以下**最小改动**，其余逻辑（pkg-manager / env / restore_user_packages / python 配置生成）保持。

### 9A.1 三个容器镜像 tag
`opencode.yaml` 里 init-setup / init-packages / opencode / pkg-manager 四处镜像
`docker.io/beclab/anomalyco-opencode:1.14.19` → **`:1.16.0-olares1`**（forked tag）。

### 9A.2 init-setup
- 删掉 `apk add --no-cache python3`（python 已 bake 进镜像）。开头那段"探测 Alpine CDN→切国内镜像"也可删（不再 apk）。
- 其余（写 SKILL、python 生成 baseline/opencode.json、写 oh-my-openagent.json、chown）**不动**，但见 9A.4 的 plugin 钉版本改动。

### 9A.3 init-packages：联网安装 → 本地 seed
现 `verify_cache` 失配时走 `apk add 一大串 + github 下 glibc + 换二进制 + npm i vite + cp -a /usr…`。改为：
- **base rootfs seed**：直接 `cp -a /usr /lib /bin /sbin /lib64 /etc/apk /etc/ssl …` 进 `.pkg-root`（这些在 forked 镜像里**已经装好**，本地拷贝、零网络）。即把现有"先装后拷"里的"装"删掉，只留"拷"。`pkg-install` 包装脚本同样改为从镜像already-baked 的 `/usr/local/bin/pkg-install` 拷（或继续在 init 里 heredoc 写，内容静态、无所谓）。
- **marker / fingerprint**：从"含包列表+OC_VER+glibc 版本"改为**绑定镜像版本/digest**（可读 `/opt/olares-bake/BAKE_MANIFEST`）。镜像换版 → marker 失配 → 自动重 seed。
- **OMO 缓存 seed（新增关键一步）**：
  ```sh
  OMO_SPEC="oh-my-openagent@${OMO_VER}"
  SRC="/opt/olares-bake/opencode-cache/packages/$OMO_SPEC"
  DST="/home/opencode/.cache/opencode/packages/$OMO_SPEC"
  if [ -d "$SRC" ] && [ ! -d "$DST/node_modules" ]; then
    mkdir -p "$(dirname "$DST")"
    cp -a "$SRC" "$DST"
    chown -R 1000:1000 /home/opencode/.cache
  fi
  ```
  仅当 `OMO_VER` = 镜像里 bake 的默认版时 `$SRC` 存在 → 命中、零联网；用户改成别的版本 → `$SRC` 不存在 → 不 seed，opencode 运行时自己联网拉（与今天回退语义一致）。
- `restore_user_packages` / `verify_cache`（列表与 bake 内容对齐即可）**保留**。
- `olares_run_omo` 的"npm 全局装 oh-my-opencode"那条可**删除**（已被缓存 seed 取代；见 §6.3 决策点），或保留作为额外兜底——倾向删除以消除 §6.3 的不一致。
- **Olares CLI（`@olares/cli`）seed = 无需额外步骤**：镜像 final 阶段已 `npm install -g @olares/cli@latest`，JS shim + postinstall 下载的 Go 二进制（`vendor/olares-cli`）都落在 **npm 全局前缀（rootfs）**，随上面的 base rootfs 快照一并进 `.pkg-root`。即与 `vite` 同机制，`olares-cli` 命令在三容器里都可用，**init 不用为它单加 seed**。（对应官方文档「运行在 Olares 内的应用其容器镜像预装 olares-cli」的姿势。）
- **Olares Agent Skills seed（新增一步，与 OMO 缓存对称）**：skills 装在 `~/.config/opencode/skills`（即 `/home/opencode/.config/...`，被 appData hostPath 覆盖），故镜像把它们烤到 `/opt/olares-bake/opencode-skills/`，init 首启 seed：
  ```sh
  SRC="/opt/olares-bake/opencode-skills"
  DST="/home/opencode/.config/opencode/skills"
  if [ -d "$SRC" ] && [ ! -d "$DST" ]; then
    mkdir -p "$DST"
    cp -a "$SRC/." "$DST/"
    chown -R 1000:1000 /home/opencode/.config
  fi
  ```
  marker 同样绑镜像版本（换镜像 → 重 seed）。实测 `skills add beclab/Olares -a opencode` 会装 **7 个**（olares-cluster/-dashboard/-files/-market/-settings/-shared/-chart）。**⚠️ 注意**：其中多个 skill 的 `description` 超过 opencode/zed/codex 文档的 1024 字符限制；opencode 会**静默加载**（不报错、不截断），但超长描述会膨胀 agent 的 skill 上下文。是否默认随镜像发这套 skills 属产品取舍——根因是 `beclab/Olares` 侧 skill 描述编写问题，与本镜像无关，此处显式标注。
  > 实现注意：`npx` 拉取的 `skills` 工具版本不同，写入目录会变（旧版 `~/.config/opencode/skills`，当前版 `~/.agents/skills`）。Dockerfile 不写死该目录，而是**按 `SKILL.md` 收集** skill 目录后搬到 staging；运行时 seed 目标仍是 opencode 真正读取的 `~/.config/opencode/skills/`（与 chart 自带 skill 同目录）。

### 9A.4 plugin 钉精确版本（init-setup 的 python）
python 里 `PLUGIN_NPM = "oh-my-openagent"`（裸名）→ 改为带版本：
```python
OMO_VER = os.environ.get("OPENCODE_OMO_VERSION", "4.7.5")  # 与 init OMO_VER 同源
PLUGIN_NPM = f"oh-my-openagent@{OMO_VER}"
STALE_PLUGIN_NPM = "oh-my-opencode"   # 仍清理裸/旧名
# 同时把已有的裸名 "oh-my-openagent" 也视为 stale 一并去重，避免新旧两条并存
```
使写进 `opencode.json` 的 plugin 串与 seed/缓存目录名逐字符一致 → 离线命中。`OPENCODE_OMO`（开关）控制加/不加的逻辑不变。

### 9A.5 决策点（实施前定）
- [ ] `olares_run_omo` 的全局 npm 安装：**删除**（推荐，消除 §6.3 不一致）还是保留兜底？
- [ ] pkg-manager 每次启动的 `apk del/add bash`：bake glibc 后能否去掉（§8.8，需实测）？
- [ ] `pkg-install` 脚本：镜像 bake 版 vs init heredoc 版（二选一，行为相同）。

---

## 10. 落地步骤（建议顺序，每步可单独验证）

1. **量化基线**：测当前首装/重装/重启三种场景的 init 耗时与下载字节，作为"快了多少"的对照。
2. ~~**验证未知项**~~ **全部已验**：OMO schema 兼容性 ✅、npm 装 4.7.5 ✅、**插件 loader 读取路径 ✅（容器内 `--network none` 断网实测，见 §6.1 / §12）**。可直接进入 fork 阶段。
3. ~~**fork Dockerfile**~~ **已产出（2026-06-05）**：`opencode-docker/{Dockerfile,build.sh,README.md}`，钉 opencode v1.16.0 + OMO 4.7.5，多架构，bake 全部预装包/glibc/二进制/vite/OMO 缓存到 `/opt/olares-bake/`。**待执行**：跑 `build.sh` 实测构建（尤其 arm64 在 QEMU 下的 OMO 预热，见 §8）+ 推 beclab 仓库。
4. **改 chart init 逻辑**：按 **§9A** 实施——四处镜像 tag→1.16.0-olares1；init-packages 改"本地 seed + OMO 缓存 seed"；init-setup 去掉 `apk add python3`；plugin 钉版本；marker 绑镜像版本。pkg-manager / OMO 开关 / env / restore 逻辑保持。
5. **回归验证**：按 §9 清单逐项过 + init 计时对比。
6. **灰度发布**：升 chart 版本打 tgz，先内部装，再放市场。

---

## 11. 参考链接

- opencode releases：https://github.com/anomalyco/opencode/releases
- opencode 官方 Dockerfile：`packages/opencode/Dockerfile`（anomalyco/opencode 仓库）
- 官方 glibc 镜像需求 / musl segfault：issue #14867、#3876、#9246
- OMO（oh-my-openagent，原 oh-my-opencode）：https://github.com/code-yeongyu/oh-my-openagent
- OMO npm（双名发布说明）：https://www.npmjs.com/package/oh-my-opencode
- OMO 安装文档（建议用 Bun）：oh-my-openagent 仓库 `docs/guide/installation.md`

---

## 12. 验证结果（2026-06-05）

### 12.1 npm 侧 spike

| 验证项 | 方法 | 结果 |
|---|---|---|
| OMO 实时最新版 | `npm view oh-my-opencode dist-tags` | **4.7.5**（早前网页搜的 4.5.1 已过时）|
| 双名发布属实 | `oh-my-opencode` 与 `oh-my-openagent` 两个包 latest 都是 4.7.5 | ✅ 确认；我们"装 oh-my-opencode + 插件项写 oh-my-openagent"是官方迁移姿势，非 bug |
| 包名/bin | 4.7.5 的 `name` 仍是 `oh-my-opencode`，多挂 `oh-my-openagent`/`omo`/`lazycodex` 等 bin 别名 | ✅ |
| **schema 向后兼容** | pack 解包 3.17.4 与 4.7.5 的 `dist/oh-my-opencode.schema.json` 对比 | ✅ 同一 `$id`；`agents`/`categories`/`runtime_fallback` 仍在、类型不变；每项 `model`/`variant`/`fallback_models` 仍合法；4.x 仅additively 增字段（agent_order、i18n、team_mode 等）；顶层 `required` 两版都仅 `git_master`（现配置没写也能跑→运行时不强制）|
| **npm 安装可行** | `npm install -g --ignore-scripts --omit=optional oh-my-opencode@4.7.5` | ✅ exit=0，`dist/index.js`+schema+bin 落地，18s |
| 平台二进制是慢点 | 全量装（含其它平台 optional 二进制）>94s | 印证：这正是 bake 要消掉的网络开销 |
| node 版本 | 传递依赖 `toml@4.1.1` 要 `node>=20`（本机 v19.8.1 报 EBADENGINE）| ⚠️ 需确认镜像内 apk nodejs ≥ 20（见 §8.5）|

### 12.2 容器侧 spike（loader 读取路径 —— 决定性）

在 `ghcr.io/anomalyco/opencode:latest` 容器内实测：

| 验证项 | 方法 | 结果 |
|---|---|---|
| **插件落盘路径** | 配 `opencode.json` plugin=`["oh-my-openagent@4.7.5"]`，触发 `opencode run` 后查 `~/.cache` | ✅ 落到 **`~/.cache/opencode/packages/oh-my-openagent@4.7.5/node_modules/`**；目录名 = plugin 数组字符串逐字符 |
| **安装判定依据** | 查该 pkgdir 顶层 | 顶层**无 package.json / lockfile**，只有 `node_modules/`；判定"已装"≈ 看目录在不在 |
| 依赖与平台二进制 | ls node_modules | ✅ 完整依赖树 + `oh-my-openagent-linux-arm64-musl` 平台包都在缓存内 |
| **断网离线加载（铁证）** | `docker commit` 含缓存的容器 → `docker run --network none` 跑 `opencode run`（DEBUG 日志）| ✅ 出现 `service=plugin path=oh-my-openagent@4.7.5 loading plugin`，**全程零 install/fetch/registry/download**；唯一报错是模型 API 因断网失败（与插件无关）|

**结论**：OMO 跨大版本到 4.7.5 **不破坏**默认配置与安装流程，"别的不能动"约束可保持。插件 loader 路径已锁定 → bake 落点明确（见 §6.1），**所有开放的技术未知项已清零，可进入 fork 实施。**
