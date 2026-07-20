# 交接日志 — audiominutes「批量处理」 (2026-07-20)

给下一个 Agent 窗口。上一个窗口把批量的**管道**打通了(translate/align/stt 三步、
已 commit、chart 已 RULE-1 重建上线、本地 8090 已起),但**用户明确不满意的两点还没做**,
这才是接下来的重点。别重复已做的部分,直接干这两件事。

---

## 0. 用户到底要什么(别理解偏)

做批量的**根本目的 = 缩短整体转写时长**:把「分好段之后」对每一段分别打的 N 次网关调用,
合并成尽量少的调用,减少每次调用的网络/排队/模型来回开销。约束只有一条:
**不许改 `llm-init` 和 `llm-gateway`;但我们自己的 wrapper(chart 里的 `wrappers.yaml`)随便改。**

### 用户当前强烈要求、尚未完成的两件事(P0)

1. **界面上必须能看到「这一步到底走没走批量」。**
   现在用户在处理页(见附图那种 30% 进度页)根本看不出 transcribe/align/translate 各步是
   「批量」还是「逐段」。要求:处理进度页 + 处理详情报告里,**每一步都标出 批量/逐段**。
   （用户原话:「触发了批量得在这界面能看到,我现在哪知道是不是在批量?」）

2. **Qwen 必须也能批量,不许偷懒。**
   上一个窗口把 Qwen/whisper 的 STT「批量」做成了"取不到 texts[] 就回退逐段",理由是它们跑
   vLLM 原生 `vllm serve` 的 `/v1/audio/transcriptions`(一次一个 file),不是我们的 wrapper。
   **用户不接受这个理由**:我们自己的 wrapper 想怎么改就怎么改,只要不动 llm-init/gateway。
   → 需要给 qwen3-asr(以及 whisper)做一个**我们自己的、支持一请求多文件**的 STT wrapper
   （用 `qwen-asr` 包的离线批量 API,或自建 in-process vLLM,像 `stream.py` 那样),
   让 STT 批量对 Qwen 真正生效,而不是回退。

> 注意语气教训:不要再用「vLLM 已经 continuous batching 所以不用做」来搪塞——用户要的是
> 一请求多文件的真批量 + 界面可见。按用户要求做,别自作主张缩范围。

---

## 1. 已完成 & 已上线(不用重做)

### 三个 commit(每个一件事,在 `apps` 分支)
- `b9914d7` 批量处理(1/3) 翻译
- `2960607` 批量处理(2/3) 对齐
- `e393054` 批量处理(3/3) 转写

### 关键实现位置(`audiominutesxdemo-app/server.js`)
- `DEFAULT_CONFIG.batch`(全局「批量处理」开关,默认 false)。
- `BATCH_OPS = { translate: true, align: true, stt: true }` + `useBatch(cfg, op)`。
- 批量调用函数:`gwTranslateBatch`(JSON,`/v1/translate`,`text` 数组→`translations`)、
  `gwAlignBatch`(multipart,`/v1/audio/align`,`files[]`+`texts[]`+`languages[]`→`results[{units}]`)、
  `gwTranscribeBatch`(multipart,`/v1/audio/transcriptions`,`files[]`→`texts[]`)。
- **批量只在「分段转写」路径(`runWindows`)生效**,已改成分阶段:整段切片 → STT → 对齐 → 组装,
  STT/对齐各自在 `useBatch` 时合成一次调用,否则逐窗。
  **默认的「整段」路径没接批量**(STT 本就 1 次;对齐走自适应 `alignLong`,没动)。
- 前端开关:`web/src/App.tsx`「转写默认值」卡片里的「批量处理」勾选 + `types.ts` 的 `batch` 字段。

### wrapper 批量(两套 chart 都改了:`audiolabx2v3` 与 `audiolabxv3` 的 `templates/wrappers.yaml`)
- `translate.py`:`text: Union[str,List[str]]`,数组→`translations`,单条→`translation`(兼容)。
- `align.py`:`files[]`+`texts[]`(+逐条 `languages`)→`results:[{units},...]`;单文件→`units`(兼容)。
- `stt_fw.py`(**仅 faster-whisper**):`files[]`→`texts:[...]`;单文件保持 OpenAI 契约(兼容)。

### 已部署
- **RULE-1 重建 `audiolabx2v3` 12 实例**(2026-07-17 深夜):uninstall 12 → 等待 → `market delete`
  → `market upload audiolabx2v3-1.0.0.tgz` → 重克隆 12(`-s upload`,title+4env)。
  **12 个哈希全部原样复现 → 公网 URL 不变、无需重指 provider**:
  0263ef / 93e848 / b0c2ed / 9c4797 / 818606 / dd1ed9 / 53f4c2 / cdcb44 / 0e4d03 / c84c8e /
  54d617 / 8e1b2f。全部 running。详见 `audiolabx2v3-LEDGER.md` 末尾两节。
- **`audiolabxv3` 尚未重建**(wrapper 已 commit,但没跑 RULE-1;用户测的是 x2v3,按需再说)。

### 本地服务(8090)
- 起法**必须**照 `.cursor/rules/local-service-restart.mdc`(alwaysApply)+
  `.cursor/skills/local-dev-server/SKILL.md`。教训:`&`/`nohup`/`setsid` 都会被工具回收(exit 137);
  杀端口单独一条(带 `|| true`),启动命令**只放** `node server.js` + `block_until_ms:0` +
  `required_permissions:["all","full_network"]`;**验网不验监听**:
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:8090/api/models` 必须 **200**。
- 启动命令:`cd audiominutesxdemo-app && DATA_DIR=./data PORT=8090 node server.js`。
- 上个窗口结束时:8090 由工具托管作业运行,`/api/models` 已验 200(可达网关)。若已掉,自己重起。

---

## 2. 关键技术事实(接手前先懂这些)

- **网关是"只读 `model`、multipart 其余原样透传"**:见 `llm-gateway/backend/internal/api/v1/audio.go`
  的 `audioPassthroughHandler`——它只从 multipart 里抠 `model` 解析 provider,然后
  `res.Adapter.AudioPassthrough(ctx, op, contentType, rawBody)` 把**整个原始 body 原样转发**给
  wrapper。所以「一请求多文件」的批量能直接骑现有 `/v1/audio/*` 端点,**不用动网关**。translate
  的 `/v1/translate` 是 JSON 透传,同理。→ 这就是为什么"我们自己的 wrapper 随便改"能成立。
- **STT 引擎映射**(见 `audiolabx2v3/templates/engine.yaml` 的 `$engines` + auto-select):
  - `MODEL_NAME` 含 `qwen` → `qwen3-asr`,跑 `vllm serve`(vLLM 原生 OpenAI 服务,**非**我们的 wrapper)。
  - `Systran/` / `*faster-whisper*` / `*ctranslate2*` → `faster-whisper`,跑**我们的** `/wrappers/stt_fw.py`。
  - 其它 → 默认 Whisper-on-vLLM(也是 `vllm serve`,非我们的 wrapper)。
  → 目前只有 faster-whisper 那条能批量。**P0 任务 2 就是要把 qwen(和 whisper)也做成我们自己的
    可批量 wrapper。** 参考已有的 `stream.py`(它就绕开 `vllm serve`,用 qwen-asr 包的 in-process
    vLLM 起自定义服务)。qwen-asr 有离线批量转写 API,可一次喂多段。
- **用户的默认 STT = `Qwen/Qwen3-ASR-1.7B`**(所以现在批量对他默认无效,这也是他炸的原因)。
  align 默认 `Qwen/Qwen3-ForcedAligner-0.6B`(c84c8e),diar `pyannote-community-1`。
- 12 实例的 title+4env 规格存于 `/tmp/x2_specs.tsv`(可能已被清;可用
  `olares-cli market list --mine -o json` + `cluster container env` 重新取,见 LEDGER/SKILL)。
- RULE-1 / RULE-2 / 公网 URL 要问用户 等硬规矩:`.cursor/skills/audiolabxv3-instances/SKILL.md`。
- chart 版本锁定规矩:`.cursor/skills/chart-version-lock/SKILL.md`(1.0.0 不许乱动)。

---

## 3. 建议的下一步(按用户优先级)

### P0-A：界面显示「批量/逐段」(每一步)
- server 端:`runJob` / `runTranslateJob` 里,给每步的进度 `phase` 文案区分批量/逐段
  (例如「分段批量转写」vs「分段逐段转写」、「批量词级对齐」vs「逐窗对齐」),并把实际是否走批量、
  每次批量合并了多少段,写进落盘的 `dbg`(处理详情报告,`/api/records/:id/debug` + `debugReportData`)。
- 注意 STT 批量对 vLLM 会**回退**,那这步就得如实显示「逐段(该引擎不支持批量)」——在 P0-B 完成前
  这是真实状态,别假显示「批量」。
- 前端:处理页(附图那个进度页)和详情报告里把这些标出来。相关组件在 `web/src/`(进度页 + 详情)。

### P0-B：让 Qwen(及 whisper)STT 真正支持批量
- 新增/改造一个**我们自己的** qwen STT wrapper(不走 `vllm serve` 的原生端点,或在其上包一层),
  接受 `files[]` 一次多段,返回 `texts[]`。参考 `stream.py` 的 in-process vLLM + qwen-asr 用法。
- 引擎选择:`engine.yaml` 里 qwen3-asr 那条 cmd 改成跑我们的 wrapper(类似 faster-whisper 那条),
  或加一个批量专用引擎分支。**只改 chart,不动 llm-init/gateway。**
- 做完要 **RULE-1 重建 `audiolabx2v3`**(照 LEDGER 的流程,哈希应能复现、URL 不变)。
- 验证:分段转写 + 批量,STT 选 Qwen,确认走的是一请求多文件(看引擎日志 + server 日志),且界面显示「批量」。

### 收尾
- 每步做完:本地 8090 重起并 `/api/models` 验 200;需要部署 wrapper 改动就 RULE-1 重建。
- commit 按「一件事一个 commit」,中文信息,前缀 `audiominutes` / `audiolabx2v3`。
- 更新本文件 + `audiolabx2v3-LEDGER.md`。

---

## 4. 别再犯的错(上个窗口踩过)
- 起服务不看 rule/skill、用 `&` 后台 → 被回收。**先读 `local-service-restart.mdc`,照四步做,验网不验监听。**
- 权限只给 `["all"]` → 可能被掐外网(能 LISTEN 但调网关 FETCH FAILED)。**要 `["all","full_network"]`。**
- 用「vLLM 自带 batching」搪塞用户的「Qwen 要真批量」——**用户不接受,照做。**
