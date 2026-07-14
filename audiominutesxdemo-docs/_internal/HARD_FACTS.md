# 思想钢印 · audiominutesxdemo 网关/模型硬事实（实测过，禁止再探）

> 这里只放**已经实测验证、结论确定**的事实。任何在这里有答案的问题，**直接引用本文件，严禁再发探测请求**。
> 每条都标注：结论 / 实测证据 / 探测日期。

---

## 1. Qwen/Qwen3-ASR-1.7B 是否返回时间戳？——【否，彻底没有】

**结论（钢印）：Qwen3-ASR-1.7B 在本网关（OpenAI 兼容 `/v1/audio/transcriptions`）上不提供任何时间戳。
STT 只给纯文本。任何「用 STT 自带时间戳来切文本 / 定位窗口」的方案（曾称“方向二”）此路不通，永久排除。
时间戳只能来自：(a) Qwen3-ForcedAligner 强制对齐，或 (b) 分段 STT——对每段音频单独 STT，用“构造”的方式保证文本-音频对应。**

**实测证据（2026-07-14，网关 `cdc01162.olarestest003.olares.com`）：**

- 请求 `response_format=verbose_json` + `timestamp_granularities[]=word,segment`：
  网关返回 **HTTP 400**：
  ```json
  {"error":{"message":"Currently do not support verbose_json for Qwen/Qwen3-ASR-1.7B","type":"BadRequestError","code":400}}
  ```
- 请求 `response_format=json`（代码里 `sttParams` 对非 Whisper 就发这个）：只回
  ```json
  {"text":"...(纯文本)...","usage":{"type":"duration","seconds":29}}
  ```
  **没有 `words`、没有 `segments`、没有任何时间字段。**

- 代码佐证：`server.js` 的 `sttParams()` 对 Qwen 只发 `{response_format:"json"}`；
  `gwAudioOp()` 之后 `const fullText = stt?.text` —— 就算有结构也只取 text。整段 STT 手上永远只有一条无时间的字符串。

**推论（同样钢印）：** 长音频对齐之所以要“猜哪段文字配哪段音频”，正是因为 STT 不给时间戳。
这是架构的根本约束，不是可以靠换 STT 参数绕过的。

---

## 2. Qwen3-ForcedAligner-0.6B 的可靠区间 & 失败模式

**结论：** 对齐器对单次切片只在 ~255s 内可靠；超出后时间戳“堆平/饱和”。
此外**对某些音频切片会整片塌陷**（返回的词全堆在切片开头，`covA≈1s`），且**同一输入 run-to-run 有非确定性噪声**（多次调用 covA 不同）。塌窗时 `匹配(matchRate)` 仍可为 1.00 —— 因为 matchRate 只衡量“对齐器吐的词能否在所喂文本里顺序找到”，**不衡量“所喂文本是否真的对应这段音频”**。

**证据：** WORK_LOG_2026-07-14；测试机 Vault 窗 3（6:22→11:12）串行/并发三次均塌到 covA≈0.96s，而本地另一份 Vault 同区间对齐到 253s（两份文件 STT 文本 covC 4685 vs 4683，说明输入本就不同）。

---
