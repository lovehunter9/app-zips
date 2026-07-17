// Register the Qwen3-Embedding-0.6B (embedding) instance as an LLM Gateway
// provider, for the audiominutesxdemo「智能问答 / RAG」feature.
//
// Instance: llamacppllmbasev327e7ba  (cloned from llamacppllmbasev3)
//   MODEL_NAME=Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0  MODEL_MODE=embedding
//   -> OpenAI POST /v1/embeddings
//   namespace: llamacppllmbasev327e7ba-shared
//   public dashboard (SSO-gated, open in browser): https://67ab3fc5.olarestest003.olares.com/
//
// HOW TO RUN: open the LLM Gateway CONSOLE page in your browser (already logged
// in), open DevTools -> Console, paste this whole snippet, press Enter.
// Same-origin fetch carries the SSO cookie; the console API needs NO Bearer token.
//
// base_url uses the cluster-INTERNAL sharedEntrances service (no public edge, no
// SSO, no ~17s first-byte timeout). If your gateway can't reach it, fall back to
// the public entrance:  "https://67ab3fc5.olarestest003.olares.com/v1"
(async () => {
  // --- edit these if the instance / model change ------------------------
  const BASE_URL = "http://sharedentrances-api.llamacppllmbasev327e7ba-shared:80/v1";
  const PROVIDER_NAME = "embedding-qwen3-0-6b";
  const MODEL_NAME = "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"; // must match the engine's /v1/models id
  const MODE = "embedding";
  // ----------------------------------------------------------------------

  const post = async (path, body) => {
    const r = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${text}`);
    return json;
  };

  console.log("[1/2] creating provider %s -> %s", PROVIDER_NAME, BASE_URL);
  const prov = await post("/console/api/providers", {
    name: PROVIDER_NAME,
    provider_type: "openai_compatible",
    base_url: BASE_URL,
    credentials: { api_key: "sk-noauth" }, // upstream needs no auth; field is required
  });
  const pid = prov.id || prov?.data?.id || prov?.provider?.id;
  console.log("      provider id =", pid, prov);
  if (!pid) throw new Error("could not find provider id in create response");

  console.log("[2/2] attaching model %s (mode=%s)", MODEL_NAME, MODE);
  const model = await post(`/console/api/providers/${pid}/customizable-models`, {
    name: MODEL_NAME,
    mode: MODE,
  });
  console.log("      model =", model);

  console.log("done. provider=%s  model=%s  mode=%s  base_url=%s",
    pid, MODEL_NAME, MODE, BASE_URL);
  console.log("Next: pick this model as 问答·嵌入模型 in the demo 设置 (it appears under mode=embedding), " +
    "then 详情页 -> 智能问答 -> 构建索引 -> 提问.");
})().catch((e) => console.error("registration failed:", e));
