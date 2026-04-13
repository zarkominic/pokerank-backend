// Cache models list for 1 hour to avoid extra requests on every scan
let _cachedModels = null;
let _cacheTs = 0;

const PROMPT = 'Pokemon GO screenshot. Reply ONLY raw JSON, no markdown: {"pokemon":"Name","cp":0,"stars":0,"atk_bar":"full","def_bar":"full","sta_bar":"full","is_encounter":false}';

// Fallback list in case the models API call fails
const FALLBACK_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "qwen/qwen-2-vl-7b-instruct:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
];

async function getFreeVisionModels(apiKey) {
  const now = Date.now();
  if (_cachedModels && now - _cacheTs < 3600_000) return _cachedModels;

  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (!r.ok) return FALLBACK_MODELS;
    const { data } = await r.json();

    const free = (data || []).filter(m => {
      if (!m.id.endsWith(":free")) return false;
      const modality = m.architecture?.modality || "";
      const inputs = m.architecture?.input_modalities || [];
      return modality.includes("image") || inputs.includes("image");
    }).map(m => m.id);

    if (free.length) {
      _cachedModels = free;
      _cacheTs = now;
      return free;
    }
  } catch (_) {}

  return FALLBACK_MODELS;
}

async function tryModel(model, image, mediaType, apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pokerank-backend.vercel.app",
      "X-Title": "PokeRank GO"
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mediaType || "image/jpeg"};base64,${image}` } },
          { type: "text", text: PROMPT }
        ]
      }],
      max_tokens: 300,
      temperature: 0
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || JSON.stringify(data));
  return data;
}

function isModelUnavailable(msg) {
  return msg.includes("No endpoints") ||
         msg.includes("not a valid model") ||
         msg.includes("not found") ||
         msg.includes("deprecated") ||
         msg.includes("unavailable") ||
         msg.includes("not supported");
}

function isAuthError(msg) {
  const lower = msg.toLowerCase();
  return lower.includes("unauthorized") ||
         lower.includes("invalid key") ||
         lower.includes("api key") ||
         lower.includes("403");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ status: "ok" });

  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENROUTER_API_KEY not configured" });

    const models = await getFreeVisionModels(apiKey);
    let lastError = "No free vision models available";

    for (const model of models) {
      try {
        const data = await tryModel(model, image, mediaType, apiKey);
        const txt = (data.choices?.[0]?.message?.content || "").trim();
        const m = txt.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("No JSON in response");
        return res.status(200).json({ ...JSON.parse(m[0]), _model: model });
      } catch (err) {
        lastError = err.message;
        if (isAuthError(err.message)) {
          return res.status(401).json({ error: "Invalid API key" });
        }
        // Any other error: try next model
        continue;
      }
    }

    return res.status(500).json({ error: lastError });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
