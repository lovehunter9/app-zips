# Translate API

MTran-compatible translation endpoints exposed by **llm-init** when
`MODEL_SUPPORTS` includes `supports_translate`.

Paths are on the **host root** (not under `/v1`).

| Method | Path | Ready required |
|--------|------|----------------|
| `POST` | `/translate` | yes |
| `POST` | `/translate/batch` | yes |
| `GET` | `/languages` | no (metadata only) |
| `POST` | `/detect` | yes |

**Content-Type:** `application/json` for all POST bodies.

**Base URL examples**

- Entrance (Authelia cookie required): `https://<entrance-host>/`
- Cluster-internal (no cookie): `http://download-svc.<app>-shared:8090/`

---

## POST `/translate`

Single-text translation.

### Request

```json
{
  "from": "zh-Hans",
  "to": "en",
  "text": "你好",
  "html": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | no | Source language code. Empty or `"auto"` = auto-detect. |
| `to` | string | **yes** | Target language code. |
| `text` | string | **yes** | Text to translate (whitespace preserved; empty string rejected). |
| `html` | boolean | no | Accepted for MTran clients; **ignored** (no HTML mode). |

### Response `200`

```json
{
  "result": "Hello"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `result` | string | Translated text. `<`, `>`, `&` are **not** HTML-escaped. |

### curl

```bash
curl -sS -X POST 'http://HOST:PORT/translate' \
  -H 'Content-Type: application/json' \
  -d '{"from":"zh-Hans","to":"en","text":"你好"}'
```

---

## POST `/translate/batch`

Batch translation. Texts are translated **sequentially** (one LLM call each).

### Limits

- Max body size: **1 MiB**
- Max `texts` length: **64**

### Request

```json
{
  "from": "en",
  "to": "zh-Hans",
  "texts": ["Hello", "Thanks"],
  "html": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | no | Same as `/translate` (`""` / `"auto"` = auto). |
| `to` | string | **yes** | Target language code. |
| `texts` | string[] | **yes** | Array of strings (may be empty → `results: []`). |
| `html` | boolean | no | Accepted; ignored. |

### Response `200`

```json
{
  "results": ["你好", "谢谢"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `results` | string[] | One result per input, same order as `texts`. |

If any item fails, the whole request fails (no partial `results`).

### curl

```bash
curl -sS -X POST 'http://HOST:PORT/translate/batch' \
  -H 'Content-Type: application/json' \
  -d '{"from":"en","to":"zh-Hans","texts":["Hello","Thanks"]}'
```

---

## GET `/languages`

Supported language codes and directed pairs (MTran / Mozilla translations-models-v2 shape).

Does **not** require the inference engine to be ready.

### Request

No body. No query parameters.

### Response `200`

```json
{
  "languages": [
    "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "da", "de",
    "el", "en", "es", "et", "eu", "fa", "fi", "fr", "gl", "gu",
    "he", "hi", "hr", "hu", "id", "is", "it", "ja", "kn", "ko",
    "lt", "lv", "ml", "ms", "nb", "nl", "nn", "pl", "pt", "ro",
    "ru", "sk", "sl", "sq", "sr", "sv", "ta", "te", "th", "tr",
    "uk", "vi", "zh-Hans", "zh-Hant"
  ],
  "pairs": [
    { "from": "en", "to": "zh-Hans" },
    { "from": "zh-Hans", "to": "en" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `languages` | string[] | 54 MTran language codes. |
| `pairs` | object[] | Directed pairs `{from,to}` (102 pairs). |

Chinese codes are `zh-Hans` / `zh-Hant` (not `zh-CN` / `zh-TW` in the list). Client aliases such as `zh-CN` are normalized when calling translate/detect.

### curl

```bash
curl -sS 'http://HOST:PORT/languages'
```

---

## POST `/detect`

Language detection.

### Request

```json
{
  "text": "今天天气真好",
  "minConfidence": 0.5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | no | Text to detect. Empty → `{ "language": "" }`. |
| `minConfidence` | number | no | If set, response includes `confidence`. If confidence &lt; threshold, `language` is cleared to `""`. |

### Response `200` (without `minConfidence`)

```json
{
  "language": "zh-Hans"
}
```

`confidence` is **omitted**.

### Response `200` (with `minConfidence`)

```json
{
  "language": "zh-Hans",
  "confidence": 1.0
}
```

Below threshold example (`minConfidence: 1.1` on a heuristic CJK hit with confidence `1.0`):

```json
{
  "language": "",
  "confidence": 1.0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `language` | string | Detected MTran code, or `""` if unknown / below threshold. |
| `confidence` | number | Present only when `minConfidence` was sent. Heuristic CJK → `1.0`; LLM parse success → `0.9`; unparsed → `0`. |

Pure CJK (Han / Hiragana·Katakana / Hangul) uses a fast path and does not call the LLM.

### curl

```bash
curl -sS -X POST 'http://HOST:PORT/detect' \
  -H 'Content-Type: application/json' \
  -d '{"text":"今天天气真好"}'
```

```bash
curl -sS -X POST 'http://HOST:PORT/detect' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Bonjour","minConfidence":0.5}'
```

---

## Errors

All translate handlers use this JSON shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "to is required"
  }
}
```

| HTTP | `error.code` | When |
|------|--------------|------|
| `400` | `invalid_request` | Missing/invalid body, empty `text`, missing `to`, unknown language, `texts` missing / &gt; 64, bad JSON |
| `413` | `payload_too_large` | Body &gt; 1 MiB |
| `408` | `request_canceled` | Client context canceled mid-batch |
| `500` | `translation_error` | Upstream LLM / completion failure |
| `503` | *(plain text / non-JSON)* | Engine not ready (`Wrap` readiness gate on POST routes) |

Example validation error:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "unsupported target language: xx"
  }
}
```

---

## Language notes

- Prefer codes from `GET /languages` (`zh-Hans`, `en`, `ja`, …).
- `from: "auto"` or omit/`""` enables source auto-detect on translate.
- Aliases (e.g. `zh-CN` → `zh-Hans`) follow MTran normalization; canonical list codes are preferred.
- `html` is wire-compatible only; LLM path does not rewrite HTML.

---

## Capability gate

Routes are mounted only when the chart sets:

```text
MODEL_SUPPORTS=supports_translate
```

(or includes `supports_translate` among comma-separated supports).  
Check availability via `GET /api/endpoints` (category Translate) or the Status panel **Translate** section.
