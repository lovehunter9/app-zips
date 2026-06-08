# OpenCode：进一步瘦身 chart + 缩短 init 时长 方案（2026-06-08）

> 目标：在「用户行为完全不变」的前提下，①把 chart 复杂度降到尽量低；②进一步缩短初始化时长（当前升级 init 约 2 分钟）。本文只做分析与方案，不改代码。

---

## 0. 先量化（动手前请采集，便于把"能省多少"说准）

在测试机 root shell 跑：

```bash
APPDATA=<opencode 的 appData 路径>      # Control Hub 里 opencode-home 卷的 hostPath
du -sh  "$APPDATA/.pkg-root"            # 基础快照总量（升级时被 rm+cp 重建的就是它）
du -sh  "$APPDATA/.pkg-root/usr"        # 大头：go/rust/node/python
du -sh  "$APPDATA/.cache/opencode/packages"   # OMO 缓存（377MB 量级）
find "$APPDATA/.pkg-root/usr" -type f | wc -l  # 文件数 —— cp -a 慢主要是它（IOPS）
```

预期：`.pkg-root/usr` 数百 MB ~ 1GB+，且**文件数十万级**（go/rust/node_modules 全是小文件）。

---

## 1. 诊断：时间花在哪、复杂度在哪

### 1.1 时间（升级 ~2min 的来源）
升级时镜像指纹变 → marker 不匹配 → 走"全量重建"：

- **`rm -rf .pkg-root` + `cp -a /usr /lib /bin …`（opencode.yaml 第 882–899 行）= 绝对大头**。
  慢不是因为字节多，而是 `/usr` 里 go/rust/node 有**几十万个小文件**，`cp -a` 是 **IOPS 受限**，所以是分钟级。
- `seed_omo_cache`（377MB）：**仅当 OMO 版本变化才拷**；同版本升级会跳过（DST 已存在）。多数升级不付这笔。
- `seed_skills`：按指纹打戳，升级会重拷一次，但 skills 很小，可忽略。
- `restore_user_packages`：仅当用户装过包才 apk 联网恢复。

**结论：升级时长 ≈ 基础 rootfs 的 `cp -a`（小文件 IOPS）。其余都小或可跳过。**

### 1.2 复杂度（chart ~1300 行的来源）
几乎全是 **init 容器内联 shell 在"生成内容"**：

| 内容 | 位置 | 行数量级 |
|---|---|---|
| web-preview / system-admin 两个 SKILL.md 正文（printf） | init-setup | ~200 |
| 管理 opencode.json / 清理 legacy 的 python 脚本（printf 成 .py） | init-setup | ~120 |
| oh-my-openagent.json 默认配置（printf） | init-setup | ~130 |
| pkg-install wrapper（heredoc） | init-packages | ~150 |
| 快照 / verify_cache / restore / seed 逻辑 | init-packages | ~250 |
| pkg-manager 循环 + apk 操作 | pkg-manager | ~120 |

这些**本质是静态文件或固定逻辑**，却以"运行时拼字符串"的形式写在 chart 里 —— 这就是复杂度的根。

---

## 2. 方案：两个目标分别下手

### A. 降复杂度（Phase 1，低风险，建议先做）

**思路：把"生成的内容"和"固定逻辑"全烤进镜像，chart 只剩"挂卷 + 传 env + 调脚本"。**

镜像里新增（都放在不被 overlay 覆盖的中性目录，如 `/opt/olares-bake/`）：
- `skills/web-preview/SKILL.md`、`skills/system-admin/SKILL.md`（静态文件）
- `oh-my-openagent.default.json`（静态文件）
- `configure-opencode.py`（现在那段 python，原样成文件）
- `pkg-install`（现在那段 wrapper，原样成文件）
- `bin/init-setup.sh`、`bin/init-packages.sh`（现在两段 init 逻辑，原样成脚本）

chart 改成（示意）：
```yaml
initContainers:
  - name: init-setup
    image: <baked>
    command: ["/opt/olares-bake/bin/init-setup.sh"]
    env: [ OLARES_OC_DOMAIN, OLARES_ENABLE_OMO, OLARES_OMO_VERSION ]
  - name: init-packages
    image: <baked>
    command: ["/opt/olares-bake/bin/init-packages.sh"]
```
chart 体量预计 **~1300 → ~250 行**。

- **行为**：逻辑一字不改、只换存放位置 → 用户侧完全无感。
- **附带收益**：以后改 init 逻辑＝改镜像里的脚本（可单测、有版本），不再动 chart；脚本能在镜像构建时 `sh -n` 语法检查。
- **风险**：低。唯一要注意：脚本里现在用 helm 模板插值的地方（`{{ $opencodeDomain }}`、OMO 版本默认值）要改成**读环境变量**（chart 通过 env 传入）。本来就该这样。
- **时间收益**：基本没有（大头是 cp，不在这）。这一步是为"可维护性"。

---

### B. 缩时间：消除/缩小升级时的大拷贝

#### B1（Phase 2，中风险，**性价比最高**）：让"基础快照"与版本解耦，升级直接跳过大拷贝

**关键洞察**：现在升级必重建快照，是因为指纹（BAKE_MANIFEST）含 opencode/OMO/cli/skills 版本，**每次升级都变**。但 `.pkg-root` 里**真正随版本变的只有 opencode/vite/olares-cli 这几个二进制**；apk 基础工具链（go/rust/node/python，占体积与文件数的大头）**很少变**。

**做法**：
1. 把**版本相关的二进制**（opencode、vite、olares-cli）从 npm 全局 `/usr/...` 挪到**不被 overlay 覆盖的镜像路径**，例如 `/opt/olares/bin`（连同各自的 node_modules），并把该目录加到 PATH 最前。→ 这些随镜像直接提供、升级即生效，**不进 `.pkg-root` 快照**。
2. `.pkg-root` 快照指纹改为**只基于 apk 基础包集合 + 架构**（不含 opencode/OMO/cli 版本）。
3. 结果：
   - 只升级 opencode/OMO/cli（绝大多数情况）→ apk 基础集合没变 → 指纹不变 → **跳过 `cp -a`，init 降到秒级**。
   - 仅当我们主动升级工具链（少见）才重建一次基础快照。

- **行为**：用户照样能 `pkg-install` 装包、照样持久化（apk 基础层 + 用户包仍在 `.pkg-root`）；opencode/cli 版本照常升级；完全无感。
- **风险**：中。要确认 overlay 后 `/usr` 与 `/opt/olares/bin` 的 PATH/库链路无冲突；`verify_cache`、运行时 `which opencode`、terminal sidecar 的 `--shell=opencode` 都改走新 PATH。olares-cli 的 vendor Go 二进制也要随之到 `/opt`。
- **首装**：仍要拷一次 apk 基础层（一次性）。要连首装也免拷，看 B2。

#### B2（Phase 3，高风险，需先验证特权）：OverlayFS，彻底零拷贝

用真正的 overlay 文件系统：**lowerdir = 镜像里的基础 rootfs（只读、已在磁盘、零拷贝）**，**upperdir = 小 hostPath（只存用户改动）**，合并后挂到各容器的 `/usr`。

- **收益**：连首装的基础拷贝都没了；`.pkg-root` 只存用户增量 → 体积与时间都最小。
- **难点 / 待验证**：
  - 需要**特权 init 容器**（CAP_SYS_ADMIN）挂 overlay；我们刚撞过的 OPA 策略是"root **或** privileged + 不受信 registry 才拒"。现在已用受信 registry（beclab），**privileged 是否放行需实测**（让用户用 root kubectl 查 OPA 约束）。
  - 跨容器共享 overlay 合并视图：需在节点 hostPath 上挂 overlay，再用 `mountPropagation` 把合并目录传进 opencode/pkg-manager 容器。可行但精细。
- **结论**：作为"终极形态"备选，**先不做**，等 B1 落地、且确认 OPA 允许 privileged 再评估。

#### B3（可独立调研）：OMO 缓存改"只读直读"，免 377MB 拷贝
opencode 插件缓存默认在 `~/.cache/opencode/packages`。若 opencode 支持把缓存目录指到只读路径（如 `XDG_CACHE_HOME` 或配置项），可让它**直接读镜像里 `/opt/olares-bake` 的 OMO 缓存**，省掉 seed 的 377MB 拷贝。

- 注意：`~/.cache` 还要可写（opencode 运行时也写缓存），不能整体只读 → 需确认能否**只把 plugin packages 目录指到只读位置**，其余仍可写。
- **待调研**：opencode 是否支持插件缓存目录可配置。OMO 拷贝只在"换 OMO 版本"时发生，非每次升级成本，**优先级低**。

---

## 3. 行为不变性核对表（每个 Phase 都要守住）
- ✅ `OPENCODE_OMO` 开关、`OPENCODE_OMO_VERSION` 切版本
- ✅ `pkg-install` 装/删/搜/列，及**用户包跨重启/升级持久化**
- ✅ pip/npm/go/cargo 生态包持久化（venv、npm-global、GOPATH、CARGO_HOME 不变）
- ✅ 主容器普通用户（UID 1000）运行
- ✅ web-preview / system-admin / olares skills 仍在 `~/.config/opencode/skills`
- ✅ olares-cli 可用
- ✅ 域名 / `__preview` baseline 指令、opencode.json 管理逻辑不变

---

## 4. 需要先验证的未知项
1. **量化**（见 §0）：`.pkg-root/usr` 体积与文件数，确认 cp 是瓶颈。
2. ~~**OPA 是否允许受信 registry 的 privileged 容器**~~ → **已确认：允许**（2026-06-08）。
   `os-platform/untrusted-pod-check` 这条 rego 只有一个 deny：`is_untrusted_image AND is_root_user`，
   其中 `is_root_user` 把 `runAsUser==0 / runAsNonRoot==false / privileged==true` 同等对待，
   **且仅在镜像不受信时才拒**。镜像 `docker.io/beclab/...`（去 `docker.io/` 前缀后命中 `beclab/` 白名单）
   受信 → privileged 放行。无任何单独禁 privileged 的规则；gatekeeper 为空。白名单里本就有
   `docker:dind`、`redroid/` 等必须特权的镜像 → 特权-受信是 Olares 既有且上架可接受的模式。
   内核也支持 overlay（`/proc/filesystems` 有 `nodev overlay`）。**→ B2/OverlayFS 技术可行。**
3. **opencode 插件缓存目录是否可配置**（决定 B3）。
4. B1 里把 opencode/vite/olares-cli 移到 `/opt/olares/bin` 后，PATH/库链路与 `--shell=opencode` 是否全通。
5. **（新，OverlayFS 唯一真风险）跨容器共享 overlay 合并视图**：privileged sidecar 挂
   overlay 后，用 `mountPropagation` 让非 root 容器看到同一 `/usr`，并验证 `apk add` 的包在
   **删 Pod 重建后仍在、且非 root 容器可见**。需 POC 验证。

## 4A. OverlayFS 形态（特权可用后的首选终点）
- **挂载者**：让现有的 `pkg-manager`（已是 root sidecar）改 `privileged: true`，启动时
  `mount -t overlay overlay -o lowerdir=<镜像只读 /usr>,upperdir=<hostPath>/usr-upper,workdir=<hostPath>/usr-work <共享挂载点>`，
  并以 `mountPropagation: Bidirectional` 暴露。
- **消费者**：`opencode`（UID 1000）与 init 容器以 `mountPropagation: HostToContainer` bind 该合并点到 `/usr`（及 `/lib` 等同理）。
- **删除**：`cp -a` 快照、`verify_cache`、`restore_user_packages` 拷贝循环、`.user-packages`、各 `pkg-*` 分路径卷。
- **持久化**：用户 `apk add` 写进 upperdir（hostPath）→ 天然持久、跨容器可见、无需重装恢复。
- **行为不变**：用户照常 `pkg-install`、包持久化；opencode/cli 随镜像升级；主容器仍 UID 1000。
- **风险**：mount 共享 + 传播是唯一新机制，须 POC。lowerdir 用镜像自带 `/usr` 还是单独 bake 一份只读副本，POC 时一并定。

---

## 4D. 实现落地状态（2026-06-08，chart v1.0.44，镜像未变）
已按 §4C + apkdb=reset 策略改完 `opencode/templates/opencode.yaml` 并打包 `opencode-1.0.44.tgz`：
- 新增 privileged `init-overlay`：算指纹 → 卸残留 merged → 指纹不符则清 upper/work → 对
  `usr/bin/sbin/lib/lib64` 挂 overlay(lower=镜像)。父卷 `pkg-overlay`=`appData/.pkg-overlay` Bidirectional。
- `init-packages`：删整段 `cp -a` 快照；`verify_cache`→`verify_overlay`(只查 /usr/bin/node + pkg-install)；
  marker 命中(同镜像)直接 seed 后 exit(不 apk、不联网)；fresh 路径 bind merged 后写 wrapper + `seed_etc`
  (拷 /etc/{apk,ssl,passwd,group} 到 `.pkg-overlay/etc`，注册 uid1000) + `restore_user_packages`(apk→upper)
  + seed_omo/skills + 写 marker。`restore_user_packages` 去掉手动逐文件 cp(overlay 直写 upper)。
- opencode/pkg-manager/init-packages 的 `pkg-*` 挂 `.pkg-overlay/merged/*` + `HostToContainer`；
  `/etc/{passwd,group,apk,ssl}` 改 `.pkg-overlay/etc/*`(纯持久，非 overlay)。
- 渲染校验：helm template exit 0；privileged×1、Bidirectional×1、HostToContainer×15、Snapshotting×0。
- 镜像未变(`docker.io/beclab/lovehunter9-anomalyco-opencode:1.16.0-test1`)，无需重打 CI。
- 回退：`git checkout -- opencode/`（旧 commit 已保护）。

## 4C. OverlayFS 实现细节（基于当前 chart 的精确映射，POC 通过后定稿）
**POC 结论（2026-06-08 实测）**：privileged+beclab 被 OPA 放行；init 容器挂的 overlay 退出后仍在、
主容器（含 UID 1000 非 root）经 `mountPropagation` 能看到合并视图、能读到 root 写入；upper 在
hostPath → 持久化机制成立。→ 落地。

**关键发现**：现 chart 本就用共享 hostPath bind mount 跨容器共享 `/usr` 等（opencode + pkg-manager
都 bind `.pkg-root/{usr,bin,sbin,lib,lib64}`）。慢点不是共享，而是 `opencode.yaml` 行 882-908 把整个
镜像 rootfs `cp -a` 进 `.pkg-root`。overlay 用"镜像只读层当 lower（零拷贝）"替掉它。

**apk DB 一致性（必须处理）**：`/lib/apk/db/installed` 在 overlay 下按文件 copy-up；镜像升级后 upper
里的旧 DB 会遮住新 lower DB → DB 与新基线二进制不一致。故采用"镜像变则清 upper 重来"策略：

| 场景 | 动作 | 拷基线 | 联网 |
|---|---|---|---|
| 重启（marker 命中） | 仅重挂 overlay，upper 原样 | 否 | 否 |
| 升级/首装（marker 不命中） | 清空 upper → 重挂 → `apk add` 用户包列表到新基线 → 写 marker | 否（lower=镜像） | 仅当有用户包 |

对比今天：升级从「拷整盘 + apk add 用户包」→「仅 apk add 用户包」；重启从「apk add 用户包」→「零动作」。

**chart 改动清单**：
- 新增 privileged init（或 init-packages 转 privileged）：对 `usr/bin/sbin/lib/lib64`（+ pkg-manager 的
  `etc/apk`、`etc/ssl`）挂 overlay，lower=镜像对应目录，upper/work=`appData/.pkg-overlay/{upper,work}/<dir>`，
  合并点 `appData/.pkg-overlay/merged/<dir>`，父目录 `mountPropagation: Bidirectional`。
- opencode/pkg-manager 的 `pkg-*` volumeMount：hostPath 由 `.pkg-root/<dir>` → `.pkg-overlay/merged/<dir>`，
  加 `mountPropagation: HostToContainer`。
- 删除：行 882-908 `cp -a` 快照段；`verify_cache` 深度校验简化为"overlay 挂上 + marker"。
- 保留（行为不变）：`.user-packages` / `restore_user_packages` / `ensure_apk_mirror` / `pkg-install` /
  OMO+skills seeding / 主容器 UID 1000。

**待 POC2 兜底确认（低风险）**：①bind 到容器真实 `/usr`（而非中性路径）后容器能正常启动；
②`/etc/passwd`、`/etc/group` 仍按现状用单文件 bind（不进 overlay）是否够。

## 5. 推荐路线（2026-06-08 更新：特权已确认可用）
特权放行后，OverlayFS 成为**同时满足"chart 最简 + 时间最短 + 用户无感"的首选终点**，故路线调整为：

1. **先做 OverlayFS 的 POC**（唯一真风险点 §4.5）：throwaway Pod 验证特权挂载 + `mountPropagation` 跨容器共享 + 用户包删 Pod 重建后仍在且非 root 可见。
2. **POC 通过 → 直接奔 OverlayFS 终点**（§4A）：连首装都零拷贝，并把快照/verify/restore/.user-packages/分路径卷一起删掉 → chart 既最简又最快。可与 Phase 1（把脚本烤进镜像）合并落地。
3. **POC 不通过 / 太脆 → 退回 Phase 1 + Phase 2**（非特权、可上架、首装拷一次、升级秒级）。

> 一句话：**先 POC 验证 overlay 共享这一个未知**；通则一步到位（最简且零拷贝），不通则走稳妥的 Phase 1+2。
