// Fix the model-name COLLISION between offline Qwen STT and stt_stream.
//
// PROBLEM: both the offline Qwen STT provider and the stt_stream provider were
// registered under the SAME model id "Qwen/Qwen3-ASR-1.7B". The gateway maps a
// model name -> exactly ONE provider, so:
//   • offline /v1/audio/transcriptions lands on the stt_stream provider
//     -> "audio_mode_mismatch: model ... has mode=stt_stream"
//   • the /v1/audio/stream request can land on the offline provider
//     -> streaming appears "not working"
//
// FIX: give the stt_stream provider's model a DISTINCT id. Offline STT keeps the
// original name; the two stop colliding.
//
// HOW TO RUN: open the LLM Gateway CONSOLE page in your browser (already logged
// in), open DevTools -> Console, paste this whole snippet, press Enter.
// Same-origin fetch carries the SSO cookie; the console API is cookie-gated.
(async () => {
  const OLD_NAME = "Qwen/Qwen3-ASR-1.7B";   // colliding name (offline + stream both use it)
  const NEW_NAME = "Qwen3-ASR-1.7B-stream"; // stream-only new name
  const MODE = "stt_stream";

  const api = async (path, opts = {}) => {
    const r = await fetch(path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} -> HTTP ${r.status}: ${text}`);
    return json;
  };

  const listRaw = await api("/console/api/providers");
  const providers = Array.isArray(listRaw) ? listRaw : (listRaw.data || listRaw.providers || []);
  console.log("providers:", providers.length);

  let hit = null;
  for (const p of providers) {
    const pid = p.id || p.ID;
    if (!pid) continue;
    let detail;
    try { detail = await api(`/console/api/providers/${pid}`); } catch { continue; }
    const m = (detail.models || []).find((x) => x.name === OLD_NAME && x.mode === MODE);
    if (m) { hit = { pid, provider: p.name, mid: m.id }; break; }
  }
  if (!hit) throw new Error(`could not find name=${OLD_NAME} mode=${MODE} model (already renamed?)`);
  console.log("found stt_stream model:", hit);

  await api(`/console/api/providers/${hit.pid}/models/${hit.mid}`, { method: "DELETE" });
  console.log("deleted old model row", hit.mid);

  const created = await api(`/console/api/providers/${hit.pid}/customizable-models`, {
    method: "POST",
    body: JSON.stringify({ name: NEW_NAME, mode: MODE }),
  });
  console.log("created new model:", created);
  console.log(`done. stream="${NEW_NAME}", offline STT still="${OLD_NAME}". No more collision.`);
  console.log("Back in the DEMO: refresh the model list, pick the new stream model.");
})().catch((e) => console.error("failed:", e));
