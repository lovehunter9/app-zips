// Register the two new audiovllmbasexv3 providers (Align + Whisper) on the LLM Gateway.
//
// HOW TO RUN: open the LLM Gateway CONSOLE page in your browser (already logged in),
// open DevTools -> Console, paste this whole snippet, press Enter.
// Same-origin fetch carries the SSO cookie through the entrance; /console/api/* is
// cookie-gated and needs NO Bearer token. (An external curl gets a 303 SSO redirect,
// which is why this is a DevTools snippet, not a shell script.)
//
// Two steps per provider (mirrors audio-qwen3asr-audiovllmbasexv3):
//   1. POST /console/api/providers                          -> create provider
//   2. POST /console/api/providers/:id/customizable-models  -> attach model
//      with mode=audio + supports (the audiobase gating key).
(async () => {
  // --- base_url = each instance's PUBLIC entrance + "/v1" (apiTimeout:0 -> ~300s;
  //     shared *.shared.olares.com edge is short on this box, so use public). ----------
  const PROVIDERS = [
    {
      name: "audio-align-audiovllmbasexv3",
      base_url: "https://a2995f93.olarestest003.olares.com/v1",
      model: "Qwen/Qwen3-ForcedAligner-0.6B",
      supports: { align: true },
    },
    {
      name: "audio-whisper-audiovllmbasexv3",
      base_url: "https://2f63127e.olarestest003.olares.com/v1",
      model: "openai/whisper-large-v3",
      supports: { stt: true },
    },
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
  console.log("🎉 ALL DONE — 2 providers registered (align + whisper, mode=audio).");
})().catch((e) => console.error("❌ registration failed:", e));
