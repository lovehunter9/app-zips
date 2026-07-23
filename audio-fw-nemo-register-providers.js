// Register the faster-whisper (stt) and NeMo (diar_stream) providers on the LLM Gateway.
//
// HOW TO RUN: open the LLM Gateway CONSOLE page (already logged in), DevTools -> Console,
// paste this whole snippet, press Enter. Same-origin fetch carries the SSO cookie;
// /console/api/* is cookie-gated (no Bearer needed).
//
// Two steps per provider (mirrors the other audio providers):
//   1. POST /console/api/providers                          -> create provider
//   2. POST /console/api/providers/:id/customizable-models  -> attach model
//      with mode=audio + supports (the audiobase gating key).
(async () => {
  const PROVIDERS = [
    { name: "audio-fasterwhisper-audiofasterwhisperbasexv3",
      base_url: "https://7793a7fe.olarestest003.olares.com/v1",
      model: "Systran/faster-whisper-large-v3", supports: { stt: true } },
    { name: "audio-diarstream-audionemobasexv3",
      base_url: "https://e9f5a47f.olarestest003.olares.com/v1",
      model: "diar-streaming-sortformer",       supports: { diar_stream: true } },
  ];

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

  for (const p of PROVIDERS) {
    console.log("[1/2] creating provider %s -> %s", p.name, p.base_url);
    const prov = await post("/console/api/providers", {
      name: p.name,
      provider_type: "openai_compatible",
      base_url: p.base_url,
      credentials: { api_key: "sk-noauth" }, // upstream needs no auth; field is required
    });
    const pid = prov.id || prov?.data?.id || prov?.provider?.id;
    if (!pid) throw new Error("could not find provider id in create response: " + JSON.stringify(prov));
    console.log("      provider id =", pid);

    console.log("[2/2] attaching model %s (mode=audio, supports=%o)", p.model, p.supports);
    const model = await post(`/console/api/providers/${pid}/customizable-models`, {
      name: p.model,
      mode: "audio",
      supports: p.supports,
    });
    console.log("      model =", model);
    console.log("✅ %s done (provider=%s, model=%s)", p.name, pid, p.model);
  }
  console.log("🎉 ALL DONE — faster-whisper (stt) + NeMo (diar_stream) registered.");
})().catch((e) => console.error("❌ registration failed:", e));
