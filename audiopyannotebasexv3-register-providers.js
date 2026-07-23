// Register the four audiopyannotebasexv3 providers (VAD / Diar / Speaker-embed / Enhance)
// on the LLM Gateway.
//
// HOW TO RUN: open the LLM Gateway CONSOLE page in your browser (already logged in),
// open DevTools -> Console, paste this whole snippet, press Enter.
// Same-origin fetch carries the SSO cookie; /console/api/* is cookie-gated (no Bearer).
//
// Two steps per provider (mirrors audio-qwen3asr / audio-align / audio-whisper):
//   1. POST /console/api/providers                          -> create provider
//   2. POST /console/api/providers/:id/customizable-models  -> attach model
//      with mode=audio + supports (the audiobase gating key).
(async () => {
  // base_url = each instance's PUBLIC entrance + "/v1" (apiTimeout:0 -> ~300s; the
  // shared *.shared.olares.com edge is short on this box, so use the public host).
  const PROVIDERS = [
    { name: "audio-vad-audiopyannotebasexv3",
      base_url: "https://7c7654b4.olarestest003.olares.com/v1",
      model: "silero-v5",             supports: { vad: true } },
    { name: "audio-diar-audiopyannotebasexv3",
      base_url: "https://9b4d7dd3.olarestest003.olares.com/v1",
      model: "pyannote-community-1",  supports: { diar: true } },
    { name: "audio-embed-audiopyannotebasexv3",
      base_url: "https://48109140.olarestest003.olares.com/v1",
      model: "pyannote-embedding",    supports: { speaker_embed: true } },
    { name: "audio-enhance-audiopyannotebasexv3",
      base_url: "https://fa58c7b8.olarestest003.olares.com/v1",
      model: "mtl-mimic-voicebank",   supports: { enhance: true } },
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
  console.log("🎉 ALL DONE — 4 pyannote providers registered (vad / diar / speaker_embed / enhance).");
})().catch((e) => console.error("❌ registration failed:", e));
