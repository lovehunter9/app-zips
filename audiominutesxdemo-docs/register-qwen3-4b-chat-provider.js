// Register the Qwen3-4B (chat) instance as an LLM Gateway provider, for the
// audiominutesxdemo「智能摘要」feature.
//
// Instance: llamacppllmbasev36d470a  (cloned from llamacppllmbasev3)
//   MODEL_NAME=unsloth/Qwen3-4B-GGUF:Q4_K_M  MODEL_MODE=chat  (OpenAI /v1/chat/completions)
//   namespace: llamacppllmbasev36d470a-shared
//   public dashboard (SSO-gated, open in browser): https://f5671bc0.olarestest003.olares.com/
//   (companion embedding instance for later RAG: https://67ab3fc5.olarestest003.olares.com/)
//
// HOW TO RUN: open the LLM Gateway CONSOLE page in your browser (already logged
// in), open DevTools -> Console, paste this whole snippet, press Enter.
// Same-origin fetch carries the SSO cookie through the internal entrance; the
// console API (/console/api/*) is cookie-gated and needs NO Bearer token.
//
// base_url uses the cluster-INTERNAL sharedEntrances service (no public edge, no
// SSO, no ~17s first-byte timeout) — the gateway pod resolves it directly. If your
// gateway can't reach it, fall back to the instance's PUBLIC entrance URL + /v1.
//
// Two steps, mirroring the other provider registrations:
//   1. POST /console/api/providers                          -> create the provider
//   2. POST /console/api/providers/:id/customizable-models  -> attach the model (mode=chat)
(async () => {
  // --- edit these if the instance / model change ------------------------
  // Internal shared-API service of the clone (preferred). If it doesn't resolve
  // from the gateway, swap to the public entrance:
  //   "https://f5671bc0.olarestest003.olares.com/v1"
  const BASE_URL = "http://sharedentrances-api.llamacppllmbasev36d470a-shared:80/v1";
  const PROVIDER_NAME = "chat-qwen3-4b";
  const MODEL_NAME = "unsloth/Qwen3-4B-GGUF:Q4_K_M"; // must match the engine's /v1/models id
  const MODE = "chat";
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
  console.log("Next: pick this model as 摘要模型 in the demo 设置 (it appears under mode=chat), " +
    "then 详情页 -> 智能摘要 -> 生成摘要.");
})().catch((e) => console.error("registration failed:", e));
