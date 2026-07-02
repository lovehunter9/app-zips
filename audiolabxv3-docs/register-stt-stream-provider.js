// Register the stt_stream audiolabxv3 instance as an LLM Gateway provider.
//
// HOW TO RUN: open the LLM Gateway CONSOLE page in your browser (already logged
// in), open DevTools -> Console, paste this whole snippet, press Enter.
// Same-origin fetch carries the SSO cookie through the internal entrance; the
// console API (/console/api/*) is cookie-gated and needs NO Bearer token.
// (An external curl gets a 303 SSO redirect, which is why this is a DevTools
// snippet, not a shell script.)
//
// Two steps, mirroring the earlier audio-provider registrations:
//   1. POST /console/api/providers                       -> create the provider
//   2. POST /console/api/providers/:id/customizable-models -> attach the model
(async () => {
  // --- edit these if the instance URL / model change --------------------
  const BASE_URL = "https://d123f7e6.olarestest003.olares.com/v1"; // stt_stream entrance + /v1
  const PROVIDER_NAME = "stt-stream-audiolabxv3";
  const MODEL_NAME = "Qwen/Qwen3-ASR-1.7B";
  const MODE = "stt_stream";
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

  console.log("✅ done. provider=%s  model=%s  mode=%s  base_url=%s",
    pid, MODEL_NAME, MODE, BASE_URL);
  console.log("Next: WS test via gateway ->  wss://<gateway-host>/v1/audio/stream?model=%s",
    encodeURIComponent(MODEL_NAME));
})().catch((e) => console.error("❌ registration failed:", e));
