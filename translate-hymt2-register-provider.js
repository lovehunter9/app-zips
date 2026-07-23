// Register the Hy-MT2 translate model as a gateway provider (TEMP translate path).
//
// HOW TO RUN: open the LLM Gateway CONSOLE page (logged in), DevTools -> Console,
// paste, Enter. Cookie-gated /console/api/* (no Bearer needed).
//
// IMPORTANT — base_url is the model's HOST ROOT (NO /v1): the temp gateway route
// (/v1/translate etc., commit f1bcbec) forwards to base_url + "/translate", and the
// model exposes /translate on the host root. mode=chat + supports.translate lets the
// demo discover it as a translate-capable model.
(async () => {
  const NAME = "translate-hymt2";
  const BASE_URL = "https://aea0358b.olarestest003.olares.com"; // HOST ROOT, no /v1
  const MODEL = "tencent/Hy-MT2-1.8B-GGUF:Q4_K_M";

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

  console.log("[1/2] creating provider %s -> %s", NAME, BASE_URL);
  const prov = await post("/console/api/providers", {
    name: NAME,
    provider_type: "openai_compatible",
    base_url: BASE_URL,
    credentials: { api_key: "sk-noauth" },
  });
  const pid = prov.id || prov?.data?.id || prov?.provider?.id;
  if (!pid) throw new Error("could not find provider id in create response: " + JSON.stringify(prov));
  console.log("      provider id =", pid);

  console.log("[2/2] attaching model %s (mode=chat, supports.translate)", MODEL);
  const model = await post(`/console/api/providers/${pid}/customizable-models`, {
    name: MODEL,
    mode: "chat",
    supports: { translate: true },
  });
  console.log("      model =", model);
  console.log("✅ done. Demo calls: POST /v1/translate?model=%s  and  /v1/translate/batch?model=%s",
    encodeURIComponent(MODEL), encodeURIComponent(MODEL));
})().catch((e) => console.error("❌ registration failed:", e));
