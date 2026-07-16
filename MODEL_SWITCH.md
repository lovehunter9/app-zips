# KoboldCpp 模型手动下载与切换指南

## 推荐小体积 GGUF 模型（便于快速试跑）

**SmolLM2-360M-Instruct (Q4_K_M)** — 约 **271 MB**，360M 参数，指令跟随可用，适合测试。

- **Hugging Face 页**: https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF  
- **直接下载链接**（Q4_K_M，推荐）:
  ```
  https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf
  ```

其他可选小模型（同一仓库）:
- **Q2_K** (~219 MB): `SmolLM2-360M-Instruct-Q2_K.gguf` — 更小，效果略差
- **Q8_0** (~386 MB): `SmolLM2-360M-Instruct-Q8_0.gguf` — 更大，效果更好

---

## 一、手动下载模型

### 方式 1：命令行（wget/curl）

在**能访问 Hugging Face 的机器**上执行（下载到当前目录）：

```bash
# 下载 SmolLM2-360M Q4_K_M（约 271MB）
wget -O SmolLM2-360M-Instruct-Q4_K_M.gguf \
  "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf"
```

或使用 curl：

```bash
curl -L -o SmolLM2-360M-Instruct-Q4_K_M.gguf \
  "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf"
```

### 方式 2：浏览器

1. 打开 https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/tree/main  
2. 找到 `SmolLM2-360M-Instruct-Q4_K_M.gguf`，点击文件名  
3. 在文件页点击 **Download** 下载

### 放置到应用模型目录

Helm 部署中，模型目录对应关系为：

- **宿主机路径**: `{{ .Values.userspace.userData }}/Huggingface/koboldcpp`  
  例如若 `userData` 为 `/data/userspace`，则完整路径为：`/data/userspace/Huggingface/koboldcpp`
- **容器内路径**: `/models`

请将下载好的 `.gguf` 文件**上传/拷贝到上述宿主机目录**（即对应集群节点上该 hostPath 的目录）。  
例如放到：`<userData>/Huggingface/koboldcpp/SmolLM2-360M-Instruct-Q4_K_M.gguf`。

---

## 二、修改为使用新模型并重启应用

环境变量在 ConfigMap `koboldcpp-env` 中，其中 **KCPP_ARGS** 指定了模型路径和上下文长度。要换模型，只需改这里并重启负载。

### 步骤 1：编辑 ConfigMap

```bash
kubectl edit configmap koboldcpp-env -n <你的 namespace>
```

在 `data` 里找到 `KCPP_ARGS`，把 `--model` 改为新模型文件名（路径为容器内路径 `/models/...`），例如：

```yaml
data:
  KCPP_ARGS: "--model /models/SmolLM2-360M-Instruct-Q4_K_M.gguf --contextsize 4096"
  # 其他键不变...
```

保存退出。

### 步骤 2：重启 Deployment 使配置生效

```bash
kubectl rollout restart deployment koboldcpp -n <你的 namespace>
```

或删除 Pod 让 Deployment 重建：

```bash
kubectl delete pod -l io.kompose.service=koboldcpp -n <你的 namespace>
```

等待新 Pod 就绪后，应用会使用新模型。

---

## 三、若通过 Helm 管理（可选）

若你希望用 values 控制模型路径，可在 chart 里用 `values.yaml` 传参，并在 `configmap.yaml` 中引用，例如：

```yaml
# values 示例
koboldcpp:
  modelPath: "/models/SmolLM2-360M-Instruct-Q4_K_M.gguf"
  contextSize: 4096
```

在 `templates/configmap.yaml` 中：

```yaml
KCPP_ARGS: "--model {{ .Values.koboldcpp.modelPath | default "/models/qwen2.5-1.5b-instruct-q4_k_m.gguf" }} --contextsize {{ .Values.koboldcpp.contextSize | default 4096 }}"
```

然后通过 `helm upgrade` 指定不同 values 或 `--set` 切换模型，再执行 `kubectl rollout restart deployment koboldcpp -n <namespace>` 即可。

---

## 小结

| 项目       | 说明 |
|------------|------|
| 推荐小模型 | SmolLM2-360M-Instruct-Q4_K_M.gguf（约 271MB） |
| 直接下载   | 见上方「直接下载链接」或 Hugging Face 页 Download |
| 放置位置   | 宿主机 `<userData>/Huggingface/koboldcpp/`，对应容器 `/models/` |
| 切换模型   | 编辑 ConfigMap `koboldcpp-env` 的 `KCPP_ARGS`，然后 `kubectl rollout restart deployment koboldcpp -n <namespace>` |
