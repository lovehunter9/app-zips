# Podcast TTS — handoff / resume notes (2026-04-23 EOD)

**状态**：英文已打通；中文卡在 Speaches 侧，不是 opennotebook 的锅。

## 当前 opennotebook 侧的状态（`templates/deployment.yaml`）

- `TTS_BATCH_SIZE=1` 已注入到 `opennotebook` 容器 env（附带解释注释）。
- 其余 podcast 相关 patch（clip 验证 / 静默 placeholder / tenacity 调整）**都没应用**，草稿存在 `PODCAST_TTS_PATCHES_STAGED.md`。
- STT credential routing hotfix、transformation dedupe hotfix 都保留，不在本 debug 范围内。

## 实测结论

| 场景                          | batch size | 结果                                              |
| ----------------------------- | ---------- | ------------------------------------------------- |
| 英文 (af_*)，42 clips         | 5 (默认)   | clips 0-24 OK，batch 6 起全部 `peer closed` 挂掉  |
| 英文 (af_*)，42 clips         | **1**      | **✅ 干净通过，187s，0 retry**                    |
| 中文 (af_* 英文音色误配)      | 5          | 0-byte clips + ffmpeg 合并报错                    |
| 中文 (zf_xiaoxiao 等 zh 音色) | **1**      | **❌ 首个 clip 就 HTTP 200 然后 ~46ms 断流**      |

关键证据（中文失败 trace，详见 2026-04-23 16:00:39 那次）：
- URL: `POST /v1/audio/speech`
- Response: `<Response [200 OK]>`（头发出来了）
- `~46ms` 在 `aiter_raw()` 阶段 `RemoteProtocolError: peer closed connection without sending complete message body`
- 46ms 远不够 Kokoro 推理，**说明 Speaches worker 是在开始 stream body 后立刻抛异常**

→ 不是 TCP 断连，不是 OOM，不是并发。**Speaches 在处理中文请求时 worker 当场挂**。

## 明天要做的第一件事：定位 Speaches 中文挂的根因

在 opennotebook pod 里发 curl，A/B 英中两条，同时抓 Speaches 日志。`<ns>` = opennotebook 所在 namespace，`BASE` 从失败日志里读到是 `http://edd26bab0.shared.olares.com`。

```bash
BASE=http://edd26bab0.shared.olares.com

# 英文 sanity
kubectl -n <ns> exec deploy/opennotebook -c opennotebook -- sh -c "
curl -sv -o /tmp/en.mp3 -w 'HTTP %{http_code}, size=%{size_download}\n' \
  -H 'Content-Type: application/json' \
  -X POST $BASE/v1/audio/speech \
  -d '{\"model\":\"speaches-ai/Kokoro-82M-v1.0-ONNX\",\"voice\":\"af_heart\",\"input\":\"Hello world.\",\"response_format\":\"mp3\"}'
ls -l /tmp/en.mp3; head -c 4 /tmp/en.mp3 | od -c | head -1"

# 中文复现
kubectl -n <ns> exec deploy/opennotebook -c opennotebook -- sh -c "
curl -sv -o /tmp/zh.mp3 -w 'HTTP %{http_code}, size=%{size_download}\n' \
  -H 'Content-Type: application/json' \
  -X POST $BASE/v1/audio/speech \
  -d '{\"model\":\"speaches-ai/Kokoro-82M-v1.0-ONNX\",\"voice\":\"zf_xiaoxiao\",\"input\":\"大家好，我是QQ。\",\"response_format\":\"mp3\"}'
ls -l /tmp/zh.mp3; head -c 4 /tmp/zh.mp3 | od -c | head -1"

# 另开一窗口，flush Speaches 那边的 traceback
kubectl -n <ns> logs -l io.kompose.service=speaches --tail=200 -f
```

**预期猜测**：Speaches 日志里会有 `misaki` / `pypinyin` / `jieba` / `ordered-set` 缺包，或 ONNX Runtime 报 KeyError 找不到中文 phoneme。Kokoro 用 misaki 做 g2p，misaki 的中文支持是可选 extra（`misaki[zh]`），很多打包的 Speaches image 里缺。

## 明天的分支决策

按 Speaches traceback 分叉：

1. **缺 Python 依赖（misaki[zh] / pypinyin / jieba）**
   → 去 speaches 那边的镜像/chart 加依赖重打，这块和 opennotebook 无关。

2. **缺模型文件 / voice 数据不全**
   → Speaches image rebuild，确认 Kokoro-82M-ONNX 包含 zh voice 权重。

3. **Speaches 代码里 zh 路径 bug**
   → 上游 issue + opennotebook UI 层隐藏 zh 选项做 workaround（下下策）。

## 不要再走回头路的几条

- ❌ 不要再用 af_*/am_* 英文音色去喂中文文本——100% 0-byte。
- ❌ 不要在 opennotebook 侧加 clip 验证 patch——会让单 clip 失败整 episode 崩（已经证伪过一次）。
- ❌ 不要把 `TTS_BATCH_SIZE` 拿掉——英文并发 5 会 `peer closed` 串炸（见测试表第一行）。这个值就留 1 不动。
- ✅ 定位 Speaches 的 traceback 之前不再改 opennotebook。

## 用户明确意图（最后一轮对话）

- "Speeches回头再说，我先试并发1中文" → 已做，失败。
- "不行，中文是个死" → 明天优先拿 Speaches 侧证据。
