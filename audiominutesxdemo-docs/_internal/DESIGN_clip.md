# 设计：创建片段（Create Clip）—— audiominutesxdemo

对齐飞书妙记「创建片段」。片段 = 从某条已完成记录里挑选一段或多段时间区间，拼接成一个
**完全独立的新记录**（音/视频 + 文字记录），带回链指向原出处。

## 1. 交互与约束（用户确认版）

创建入口：仅在「非片段」且 `status===done` 的记录详情页显示「创建片段」按钮。

选择：
- 可选**一段或多段**时间区间（多段拼接）。
- 编辑器复用 filmstrip 缩略图组件（同一组件也用于封面选择）。
- 单段 → 连续片段；多段 → 非连续片段（`continuous` 标记）。

生成：
- 点「创建」→ 立刻生成一条新记录，`status = "generating"`（新状态，卡片显示「生成中」）。
- 后台 ffmpeg **精确重编码**切割 + 拼接产出新媒体；完成后 `status = "done"`。
- 文字记录**不重新转写/翻译/分离**，而是从原记录的 `result` 里按所选区间**裁剪 + 时间重定基**继承而来。

片段的限制（硬约束，前后端都拦）：
- ❌ 重新识别说话人 / 重新转写 / 补翻译（补/重翻译）
- ❌ 从片段再创建新片段
- ✅ 可编辑（按句/逐段，规则同普通记录），**编辑结果与原出处独立**
- ✅ 可删除
- ✅ 可「跳回原出处」（回到父记录详情）
- ✅ 展示「连续片段 / 非连续片段」标识
- 父记录展示其片段的「关联」列表；片段展示回链。

## 2. 数据模型

记录新增字段（写在 record JSON、summary 里也带上）：

```
clipOf?: string           // 父记录 id（存在即为片段）
clipRanges?: {start:number; end:number}[]  // 相对父记录时间轴的所选区间（秒）
continuous?: boolean      // clipRanges.length === 1
clipStatus 用现有 status，新增取值 "generating"
```

RecordStatus 增加 `"generating"`。

父子关联：**单一真相存在子记录的 `clipOf`**。父记录的片段列表由 `listRecords()`
过滤 `clipOf === parentId` 得到（规模小，扫描可接受），summary 里带 `clipOf`、`continuous`。

片段的 `result` 由父 `result` 裁剪得到，独立存储；编辑走现有 `PATCH /result`，天然独立。

## 3. 服务端

### 3.1 ffmpeg 切割拼接（精确、重编码）

用 filter_complex trim+concat，一条命令搞定单/多段、音/视频：

- 视频：每段 `[0:v]trim=start=s:end=e,setpts=PTS-STARTPTS` +
  `[0:a]atrim=...,asetpts=PTS-STARTPTS`，末尾 `concat=n=N:v=1:a=1[v][a]`，
  `-map [v] -map [a]`，H.264 + AAC 输出 mp4。
- 音频：仅 `atrim` + `concat=n=N:v=0:a=1[a]`，输出 m4a/mp3。
- 再用 `toWav16kMono` 从产物抽 16k 单声道 wav 作 `audioPath`（保持 schema 一致；
  片段不转写，wav 仅备用）。
- `durationSec = probeDuration(产物)`。

### 3.2 文字记录裁剪 + 重定基

输入：父 `result.segments`（含 speaker/text/words[]/translation/twords[]）、`clipRanges`。
对每段区间 `[rs,re]`，累计偏移 `offset`（前面各段时长之和）：

- 遍历与 `[rs,re]` 有重叠的父 segment：
  - 有 words：保留 `rs<=w.start<re`（或中点落入）的词；据留下的词重建 `text`；
    每个词与段的 `start/end` 重定基 `t' = clamp(t, rs, re) - rs + offset`。
  - 无 words（fallback）：整段按与区间的交集 clamp，`text` 原样保留。
  - translation/twords 同法按同一时间窗裁剪、重定基。
  - 空裁剪结果（无词/文本）丢弃。
- 跨区间的段拆成多段（各自归属所在区间）。
- 复制父的 `speakerNames`、`participants`、`language`。
- `speakers` = 裁剪后实际出现的说话人集合。

### 3.3 端点

```
POST /api/records/:id/clip
  body: { ranges:[{start,end}...], title? }
  - 拒绝：父不存在 / 父非 done / 父本身是片段(clipOf) / ranges 非法
  - 建子记录 status=generating, clipOf=父, clipRanges, continuous
  - 立刻返回子 summary；后台 runClipJob(childId)
```

`runClipJob`：独立**串行**小队列（clipQueue，避免多片段并发抢 CPU；不占用 GPU 转写队列）。
ffmpeg 产出媒体 → 抽 wav → 裁剪 result → 写子记录 done。失败写 error + notice。

删除：现有 `DELETE /api/records/:id` 已删 media/audio/cover/json，片段直接复用；
另外父记录被删时**不级联删片段**（片段独立），但片段的回链会失效 → 前端回链前校验父是否存在。

守卫：`transcribe`/`translate`/`rediarize`/`clip` 端点开头加
`if (rec.clipOf) return 400 "片段不支持该操作"`。

## 4. 前端

### 4.1 类型 & api
- types：RecordStatus 加 `"generating"`；Summary/Full 加 `clipOf/clipRanges/continuous`。
- api：`createClip(id, ranges, title)`，`ResultPatch` 不变。

### 4.2 片段编辑器（新组件 ClipEditor 模态）
- 复用 `seekAndCapture` 生成 filmstrip（视频：等距抽帧一条缩略图带；音频：纯时间轴条）。
- 时间轴上拖拽选区，「+ 添加片段」支持多段；每段可微调 start/end、预览、删除。
- 也可从转写「勾选整段」快速生成区间（可选增强，v1 先做时间轴拖拽 + 手填）。
- 标题输入；「创建」→ `api.createClip` → 关闭并刷新列表。
- filmstrip 组件抽出，供 CoverModal 之后复用（本期先在 ClipEditor 落地）。

### 4.3 详情页
- 非片段 done：头部加「创建片段」按钮（编辑中禁用）。
- 片段：
  - 头部隐藏 重新识别说话人 / 重新转写 / 补翻译 / 创建片段；保留 编辑 / 删除 / 导出。
  - 顶部信息条显示「片段 · 连续/非连续 · N 段」+「↩ 跳回原出处」按钮（校验父存在）。
- generating 状态：详情/卡片显示「生成中…」，轮询刷新直到 done。

### 4.4 库列表卡片
- 片段卡角标「片段」；连续/非连续小标。
- generating 卡片显示转圈「生成中」。

## 5. 实施顺序
1. 后端：类型/字段 + createClip 端点 + clipQueue/runClipJob(ffmpeg+裁剪) + 四个端点守卫 + generating。
2. 前端类型/api。
3. ClipEditor 模态（filmstrip + 多段选区）。
4. 详情页：创建入口 / 片段限制 / 回链 / generating 轮询。
5. 卡片：片段角标 / generating。
6. 构建 + 8090 自测（音频多段、视频多段、连续/非连续、编辑独立、删除、守卫）。
7. 通过后重打并推送镜像（沿用 local-dev-server / buildx 流程），bump 版本。
