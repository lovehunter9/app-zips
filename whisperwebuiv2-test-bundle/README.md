# Whisper-WebUI 本开发版 实测包

本包覆盖文档定稿前的实测套件：

1. **短音频测试** — Batched vs Buffered 在 10s / 30s / 1min / 3min / 5min 各时长上的速度与质量对照
2. **受控可观测性验证** — 用响应里的 `_meta` 字段直接观测 batched / text_cleaning / segment_merging / `_BATCHED_DROPPED_KWARGS` 强制覆盖是否真生效，不依赖任何推断
3. **API 完整实测** — 对照 STT 使用指南 §2.10，验证 11 个端点的响应结构与错误路径
4. **长音频实测** — 直接拿原始的中英文长音频跑 Batched vs Buffered，验证 Batched 在长音频上的速度收益（这是 Batched 真正发光的场景）
5. **一水跑总验证（推荐）** — 把上面 1-4 串起来跑，最后聚合成**一份** `OVERALL_REPORT.txt`（执行摘要表 + 所有子报告），适合"想一次性看完所有问题"的场景

> 所有 `verbose_json` 响应额外携带 `_meta` 字段（本开发版调试用），包含 `path`（batched / buffered / batched_fallback_to_buffered）、`batched_dropped_kwargs`、`text_cleaning_active`、`segment_merging_active`、`condition_on_previous_text_used`、`batched_typeerror` 等内部决策记录；非 JSON 响应通过 `X-Whisper-*` 响应头暴露同样信息。

## 0. 一次性准备

### 0.1 上传整个 test_bundle 到 Olares

通过 **Olares Files 应用** 把整个 `whisperwebuiv2-test-bundle/` 目录上传到：

```
Files → Whisper-WebUI 输出目录 → test_bundle/   （或 test-bundle，名字随意，脚本不依赖目录名）
```

上传后，Pod 内对应路径例如 `/Whisper-WebUI/outputs/test_bundle/`。脚本通过自身位置定位资源，不依赖具体目录名，下划线 / 横线 / 任意命名都可以。

### 0.2 上传两个源音频

把以下 **两个原始文件** 上传到 `test_bundle/audio/source/`：

| 文件名 | 用途 |
|---|---|
| `流浪地球02：飞船派和地球派  于和伟演播.mp3` | 中文源（脚本自动按 CJK 字符识别）|
| `adventureholmes_02_doyle_64kb.mp3` | 英文源（脚本按纯 ASCII 文件名识别）|

文件名**保持原样即可**（脚本会根据是否含中文字符自动判定语种）。

### 0.3 打开 Whisper-WebUI 应用 Terminal

在 Olares 桌面打开 Whisper-WebUI 应用，使用应用内 **Terminal** 功能（部署清单里 `bytetrade.io/terminal: whisperwebui` 已启用），然后：

```bash
cd /Whisper-WebUI/outputs/test_bundle
```

## 1. Utility：切片（约 30 秒）

```bash
bash scripts/prepare_audio.sh
```

脚本会：
- 自动检测 `audio/source/` 中的中/英文源文件
- 用 ffmpeg 各切 5 个时长（10s / 30s / 1min / 3min / 5min），从音频第 30 秒开始（跳过可能的开场静音/音乐）
- 输出到 `audio/clips/zh_<时长>.wav` 与 `audio/clips/en_<时长>.wav`，共 10 个 16kHz 单声道 wav

执行后请确认 `audio/clips/` 下有 10 个文件，没有就看 stderr 报错。

## 2. Script 1：短音频实测（5-10 分钟）→ Report 1

```bash
bash scripts/1_run_short_audio_test.sh
```

脚本会：
- 对 10 个 clip 各跑两次（`batched=true` / `batched=false`），共 20 次调用
- 记录每次的耗时、HTTP 状态、段数、字符数、首尾词
- 生成 `results/short_audio_<时间戳>/report.md` 分析报告

完成后请把 **`report.txt`** 内容贴给我（`.md` 与 `.txt` 同内容，`.txt` 避免 markdown 渲染），我会分析：
- 是否有 Batched 反慢的样本（速度反转）
- 是否有首尾词漏识（VAD 误切）
- 段数与字符数差异是否在合理范围
- 每次调用的 `_meta.path` 是 `batched` / `buffered` / `batched_fallback_to_buffered`

## 2b. Script 1b：受控可观测性验证（约 2 分钟）→ Report 1b

```bash
bash scripts/1b_run_controlled_verification.sh
```

脚本会：
- 用 `en_30s.wav` 跑 7 个受控组合：4 种 buffered + 3 种 batched，逐一翻转 `batched` / `text_cleaning` / `segment_merging`，加一个 `condition_on_previous_text=true` 用于验证 Batched 路径会把它强制成 false
- 直接读响应里的 `_meta` 字段（路径、被剥的 kwargs、TypeError 信息）
- 生成 `results/controlled_verify_<时间戳>/report.md` 与同内容的 `report.txt`

完成后请把 **`report.txt`** 内容贴给我（避免 markdown 渲染干扰），我会对照每一项 `_meta` 字段确认 Batched 是否真在跑、新增三参数是否真生效、强制覆盖是否真发生。

## 3. Script 2：API happy path（约 5 分钟）→ Report 2

```bash
bash scripts/2_run_api_test_positive.sh
```

脚本会：
- 按 §2.10 顺序对 11 个端点跑正向调用（含 NLLB 模型首次加载 ~30s）
- 自动校验 `verbose_json` / `srt` / NLLB / DeepL 等响应的关键字段
- 默认 **跳过** YouTube 真实转录（仅测 metadata），跑实际下载请加 `RUN_YT=1`
- 额外跑 4 个 §2.10.X _meta 验证组合（buffered/batched × 后处理开/关），证明 WebUI 新增三参数在 API 路径下都生效
- 生成 `results/api_positive_<时间戳>/report.md` 与 `report.txt`

完成后请把 **`report.txt`** 贴给我。

## 4. Script 3：API 错误响应 + DeepL 连通性（约 1 分钟）→ Report 3

```bash
bash scripts/3_run_api_test_negative.sh
```

脚本会：
- 跑 13 个故意错误请求 + 1 个 DeepL 连通性请求，覆盖文档错误响应矩阵：
  - **N1**: NLLB 不传 `text` 也不传 `file` → 400
  - **N2**: NLLB 同时传 `text` + `file` → 400
  - **N3**: Transcribe 不传 `file` → 422
  - **N4**: YouTube metadata 传无效 URL → 400
  - **N5**: DeepL 不传 `auth_key` → 422
  - **N6**: DeepL 传一个无效 `auth_key` → 502（同时验证 DeepL 上游可达 + 错误包装）
  - **C1**: `/v1/translations/deepl/languages`（不需要 key）→ 200，确认 DeepL 路由层可达
  - **N7**: `batched` 传非 bool 字符串 → 422
  - **N8**: `text_cleaning` 传非 bool → 422
  - **N9**: `segment_merging` 传非 bool → 422
  - **N10**: `language` 传未知值（如 `Klingon`）→ 400 + 提示可接受形式
  - **N11**: DeepL `src_lang` 传未知值 → 400（来自 `_normalise_deepl_lang`）
  - **N12**: NLLB `src_lang` 传未知值 → 400（来自 `_normalise_nllb_lang`，对称于 N11）
  - **N13**: YouTube transcribe 不传 `youtube_url` → 422（对称于 N3）
- 生成 `results/api_negative_<时间戳>/report.md` 与 `report.txt`

完成后请把 **`report.txt`** 贴给我。

## 5. Script 4：长音频实测（约 10-30 分钟，取决于音频时长）→ Report 4

```bash
bash scripts/4_run_long_audio_test.sh
```

脚本会：
- 自动定位长音频文件，按以下顺序查找：
  - 推荐：`audio/long/zh_long.{mp3,wav,m4a,flac}` 和 `audio/long/en_long.{mp3,wav,m4a,flac}`
  - 兜底：`audio/source/*流浪地球*.mp3`（中文）和 `audio/source/*adventureholmes*.mp3`（英文）
- 对每个语种跑 2 次：Buffered（`batched=false`）和 Batched（`batched=true`），共最多 4 次调用
- 全部以 `_diag=true` 调用，响应里带 `_meta.path` 真相
- curl 超时设到 45 分钟（适配 25-45 分钟的有声书源文件）
- 生成 `results/long_audio_<时间戳>/report.md` 与 `report.txt`

完成后请把 **`report.txt`** 贴给我；这一份是 `clip_timestamps` 修复后 Batched 路径真有可能跑起来的样本，重点看：
- L2 / L4 的 `_meta.path` 应是 `batched`（而不是 `batched_fallback_to_buffered`）
- 长音频上 Batched 应**明显快于** Buffered（速度比 ≥ 1.3x，这才是 Batched 真正的价值）
- 文本相似度在 0.6~0.95 之间属于正常（VAD chunking 不同导致的合理差异）

## 6. Script 5：一水跑总验证（约 25-50 分钟）→ OVERALL_REPORT

把 1 / 1b / 2 / 3 / 4 串起来跑一遍，最后聚合成**一份** `OVERALL_REPORT.txt`，省得分四五次贴报告。任何子脚本失败都不会中断剩下的步骤，最终摘要表会标红。

```bash
# 全跑（含长音频，~25-50 分钟）
bash scripts/5_run_all_tests.sh

# 跳过长音频（~15-20 分钟）
SKIP_LONG=1 bash scripts/5_run_all_tests.sh

# 细粒度跳过：跳 1 和 4（只跑 1b/2/3，~8 分钟）
SKIP=1,4 bash scripts/5_run_all_tests.sh
```

输出：
- `results/overall_<时间戳>/OVERALL_REPORT.md` 与 `.txt`
- 头部是执行摘要表（每个步骤的状态/耗时/结果目录），后面接每个子报告的完整内容
- 退出码：全 OK → 0；任一失败 → 1

完成后把 `OVERALL_REPORT.txt` 贴给我即可（这一份就够，我会一次性看完）。

## 输出目录结构

```
test_bundle/results/
├── short_audio_<时间戳>/
│   ├── *.json                          # 20 次调用的原始响应
│   ├── summary.tsv                     # 数据汇总（excel/numbers 可打开）
│   ├── report.md                       # 分析报告（markdown 源）
│   └── report.txt                      # 同内容 .txt 镜像（贴给我用这个）
├── controlled_verify_<时间戳>/
│   ├── *.json                          # 7 次受控调用的原始响应（含 _meta 字段）
│   ├── *.headers.txt                   # 响应头（X-Whisper-*）
│   ├── summary.tsv
│   ├── report.md
│   └── report.txt
├── api_positive_<时间戳>/
│   ├── *.json
│   ├── summary.tsv
│   ├── report.md
│   └── report.txt
├── api_negative_<时间戳>/
│   ├── *.json
│   ├── summary.tsv
│   ├── report.md
│   └── report.txt
├── long_audio_<时间戳>/
│   ├── L1_zh_buffered.json / L2_zh_batched.json
│   ├── L3_en_buffered.json / L4_en_batched.json
│   ├── summary.tsv
│   ├── report.md
│   └── report.txt
└── overall_<时间戳>/                    # 5 号脚本一水跑的聚合输出
    ├── OVERALL_REPORT.md                # 头部摘要表 + 全部子报告拼接
    └── OVERALL_REPORT.txt
```

每次跑都会生成新的时间戳目录，不会覆盖历史结果。

## 常见问题

**Q：ffmpeg / curl / python 找不到？**  
A：本开发版镜像本身就包含这些；如果偶然有镜像基础层回归，脚本会自动 `apt-get install` 兜底（需要 Pod 有公网或镜像源）。

**Q：API 端口连不上？**  
A：默认指向 `http://localhost:8000`（Pod 内 FastAPI 监听端口）。如想在集群外跑，导出 `API=http://<host>:8082` 后再执行脚本。

**Q：NLLB 第一次调用超时？**  
A：首次会下载 ~2.4 GB 的 distilled-600M 模型权重到 `/Whisper-WebUI/models/NLLB/`，耗时 30-60 秒。脚本里 NLLB 调用超时设到 120 秒，第二次起就是毫秒级。

**Q：smoke check 一直显示 `{"status":"loading"}`？**  
A：这是本开发版 `/healthz` 的**正常初始状态**——代码里 `"ok"` 的条件是「Whisper 模型已加载」，而模型只在首次 `transcribe` 调用时才加载。脚本会先 smoke check（确认 FastAPI 进程活着）、再用最短的 clip 做一次 **warmup transcribe** 触发模型加载（首次 30-90 秒），加载成功后再开始正式用例。Warmup 失败才会中止，loading 状态本身不会让脚本卡死。

**Q：脚本中途出现 `[HAMI-core ...]` 和 `nvidia-smi` 输出，看起来是其他东西的干扰？**  
A：和测试脚本无关。Olares 的某些组件（或同事在另一个 terminal 里跑的 `nvidia-smi`）会向同一个 stdout 输出 HAMI 监控/调试信息。脚本本身只 curl 和写文件，看到这些行直接忽略即可，只要脚本最终打印的"完成 ✓"出现就说明跑完了。

**Q：跑到一半失败想重跑？**  
A：每次跑都新建时间戳目录，旧结果保留。失败的脚本可以直接重跑，不需要清理。
