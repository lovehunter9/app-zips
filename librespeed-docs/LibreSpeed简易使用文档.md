# LibreSpeed 简易使用文档

> 适用版本：LibreSpeed 6.1.0 / Olares 应用 1.0.0

LibreSpeed 是一个轻量的自托管网络测速工具，自带 Web UI，可同时测量下载、上传、Ping、Jitter，并把结果写入 PostgreSQL。本文档只讲日常使用，不讲安装。

---

## 一、四种 MODE

`MODE` 决定这个应用扮演什么角色，在「环境变量」里随时切换（保存即重启生效）。

| MODE | 本机 PHP 后端 | UI | 用 `servers.json` 吗 | 适合谁 |
|---|:-:|:-:|:-:|---|
| **`dual`**（默认）| ✓ | ✓ | 用 | 几乎所有人——下拉里既能选「本机」也能选远程节点 |
| `standalone` | ✓ | ✓ | 系统自动只保留 Local 一条 | 只想测本机出口，UI 下拉自动折叠 |
| `frontend` | ✗ | ✓ | 用；系统自动过滤掉指向本机的 Local 条目 | 用这台 Olares 当统一测速控制台，背后接多个远程节点 |
| `backend` | ✓ | ✗ | 忽略 | 把这台 Olares 当作给别人测速时的「被测点」。**默认安装后直接切过去并不能用**，详见 5.4 |

切换提醒：

- 切 `backend` 后，自己访问应用首页会是空白/403，因为这个模式没有 UI；同时**外部访客也访问不了**。需要按 5.4 在 Olares 设置里把鉴权改成 Public，别人才能连到你的测速端点。

---

## 二、环境变量

5 个变量，全部「按需填，可改可不填，改了自动重启」。位置在应用详情 → 环境变量。

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `MODE` | 下拉 4 选 1 | `dual` | 见上一节 |
| `TELEMETRY` | 开关 | `true` | 关掉后：不再写数据库、没有「分享结果」按钮、历史页是空的 |
| `PASSWORD` | 密码 | 空 | **历史页 `/results/stats.php` 的登录密码**。留空 = 登录页用户名/密码都留空点 LOGIN 即可进入（历史页等于公开）；要私密就填，**至少 6 位** |
| `GDPR_EMAIL` | 邮箱 | 空 | 隐私政策页里展示的「数据删除请求」联系邮箱。私人用可不填 |
| `IPINFO_APIKEY` | 密码 | 空 | ipinfo.io 的 API token。留空 = 仅用内置离线 GeoIP；填了 = 遥测记录和 Share 结果里会有更完整的 ISP/位置信息及到测速点的距离（**主界面只显示 IP**）。免费 token：https://ipinfo.io/signup |

---

## 三、测速界面使用

进入应用 → 默认就是测速首页。

1. **选测速点**：上方下拉框，第一条「Local (this Olares)」测本机出口；后面是 `servers.json` 里配置的远程节点，默认带了「Los Angeles, USA (Sharktech)」和「Amsterdam, Netherlands (Sharktech)」两个海外节点。
2. **点 LET'S START**：开始跑测试。顺序是 Ping → Download → Upload → 完成。
3. **看四个数字**：
   - **Download / Upload**：单位 Mbps（兆比特/秒）；要换成 MB/s 自己除以 8。
   - **Ping**：往返延迟，单位 ms，越小越好。
   - **Jitter**：延迟波动，越小越稳。
4. **连接信息**：开启 `TELEMETRY` 时，测速跑到 Ping 阶段后，**LET'S START 按钮下方**会出现一行「You are connected through:」和你的公网 IP。测速前、以及关掉 `TELEMETRY` 时，页面上没有这块信息。
5. **测完后**（仅当 `TELEMETRY=true`）：页面会出现 **Share** 按钮——点开能拿到一张结果图和一个 `/results/?id=<混淆ID>` 的永久链接，发给别人对方不用登录就能看。

---

## 四、历史页面使用

URL：`<你的域名>/results/stats.php`

- 入口是个登录页，用户名固定留空，**密码 = `PASSWORD` 环境变量的值**。
- **如果 `PASSWORD` 留空（默认）**：密码框也不用填，**直接点 LOGIN 即可进入**。也就是说这个页面默认是任何人都能进的——LibreSpeed 没有把空密码当作「禁用登录」处理。
- 进去之后是所有历史测试记录的列表，按时间倒序，可分页。每行包含时间、IP、ISP、四项测速数据、share 链接。
- 顶部搜索框支持按 **测试 ID**（混淆后的 ID）、**IP**、**ISP** 过滤。
- 如果只是想给别人发某次测试的结果，**不需要这个页面**——直接用测完页面的 Share 按钮拿永久链接更方便。

> 安全提示：因为留空就等于公开，**要么彻底留空（自用、并且接受历史可被别人翻看），要么填一个至少 6 位的强密码**——千万别填 1～5 位的弱密码，那是最糟糕的组合（既给了别人「猜得到」的密码，又关闭了你以为的「无密码就进不去」的保护）。

---

## 五、其他必须说

### 5.1 编辑 `servers.json`（加自己的远程节点）

文件位置：Olares「Files」应用 → `/Data/librespeed/servers.json`

- 这个文件是首次安装时由系统生成的，**之后任你编辑、应用升级或重装，都不会被覆盖**。
- 改完**必须重启应用**才会生效（Olares 应用详情 → 停止 → 启动）。
- 不同 MODE 对这个文件的处理不一样：
  - **`dual`**：原样使用，你的编辑（包括你主动删除 Local）100% 被尊重
  - **`standalone`**：运行时忽略此文件，UI 只显示 Local 一条（文件里的编辑仍保留，切回 `dual` 后恢复）
  - **`frontend`**：基于此文件，但**自动过滤掉指向本机的 Local 条目**（识别依据是 `server` 字段是否等于本机域名 / 空串 / `/`，name 字段无关）；你已经手动删了 Local 的话不会有任何影响
  - **`backend`**：UI 不开放，此文件无效

  上述对持久化文件本身**完全只读**——切换 MODE 不会丢失任何编辑，切回 `dual` 立刻恢复全量视图。

每条节点的字段：

```json
{
  "name":     "节点显示名",
  "server":   "https://<跑着 LibreSpeed 的域名>/",
  "dlURL":    "backend/garbage.php",
  "ulURL":    "backend/empty.php",
  "pingURL":  "backend/empty.php",
  "getIpURL": "backend/getIP.php"
}
```

> **JSON 格式提醒（实测踩过的坑）**：标准 JSON 不允许尾逗号——数组里**最后一项** `}` 后面**不能**跟 `,`，加了整个文件就解析失败，应用启动会卡在 servers.json 加载阶段，UI 下拉直接是空的。新增节点时记得：除最后一条外，每个 `}` 后面**都要**有 `,`；最后一条 `}` 后面**不能**有 `,`。改完拿不准的话，可以把整段贴到 <https://jsonlint.com> 之类的在线 JSON 校验器里过一遍再保存。

**远程节点必须是部署了 LibreSpeed 后端的服务器**——不能填 baidu.com、google.com 这种普通网站。另外远程服务器必须返回 `Access-Control-Allow-Origin: *`，否则浏览器会因为 CORS 直接拒掉。验证一个候选节点是否能用：

```bash
curl -I -H "Origin: https://x" https://<候选域名>/backend/empty.php
# 看 access-control-allow-origin 是不是 *，HTTP 是不是 200
```

社区维护的公共节点列表可以从这里拿：
<https://librespeed.org/backend-servers/servers.php>（注意只挑 CORS 头正确的）

### 5.2 数据持久化

- **`servers.json`**：在 `/Data/librespeed/`，跟随应用数据持久化。
- **测试历史**：在 Olares 自带的 PostgreSQL 里（`speedtest_users` 表），跟随应用数据持久化。

卸载应用时，按 Olares 通用规则，**默认保留应用数据**；只有你勾选「同时删除数据」才会真的清空。

### 5.3 测「我到 baidu 的网速」做不到

LibreSpeed 测的是「你到指定 LibreSpeed 测速服务器」的带宽，不是「你访问任意网站快不快」。后者请用浏览器 DevTools / `curl -w` / iperf3 / mtr 等工具。

### 5.4 让 backend 模式真正可用

**为什么直接切 MODE 过去不行**：Olares 给每个应用入口默认套了一层 SSO 鉴权（**Internal**），外部访客的浏览器一发请求就被 Olares 拦下、引到登录页，根本到不了 LibreSpeed 的 PHP 端点。结果就是别人在他的 LibreSpeed 里把你的域名加进 `servers.json` 后，节点一上来就被判为不可达。

**改法**（纯 Olares 界面操作，不需要重装应用）：

1. 打开 Olares **Settings**（设置） → 左侧 **Applications** → 找到 **librespeed**
2. **Access policies** 区块 → **Authentication level** 下拉 → 把 `Internal` 改成 **`Public`**
3. 顺带去应用的环境变量里把 `MODE` 切到 `backend`（如果还没切的话）

改完之后，别人的浏览器就能直接 XHR 到你的 `/garbage.php` / `/empty.php` / `/getIP.php`——他们的 LibreSpeed 把你的域名加到 `servers.json` 里就能用了。

**代价 / 安全提醒**：Authentication level 改成 `Public` 后，**这个域名上的所有路径都变成公开访问**——任何拿到你域名的人都能：

- 进来跑测速，吃你的出口带宽
- （如果你后续又切回 `dual` / `standalone`）把测试结果写进你的 PostgreSQL，污染历史数据
- 如果你设过 `PASSWORD`，他还能登录 `/results/stats.php` 看所有人的历史记录

所以**只在「确实想把这台 Olares 作为对外公共测速节点」时**才这么做。如果你只想给少数几个朋友用，更稳妥的办法是让他们在他们自己的机器上装 LibreSpeed `backend` 来用，而不是把自己这台暴露出去。

**用完想撤回**：同一个 UI 把 Authentication level 改回 `Internal`，立即生效。
