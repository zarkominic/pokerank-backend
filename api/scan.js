const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
];

const GROQ_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];

const PROMPT_BARS = `This is a zoomed crop of a Pokemon GO appraisal panel showing 3 IV evaluation bars.

The panel has 3 horizontal bars in this order from top to bottom:
1. Attack / Ataque
2. Defense / Defensa
3. Stamina / PS

Each bar is a horizontal rectangle. The LEFT portion is filled ORANGE/AMBER. The RIGHT portion is LIGHT GREY (empty).

For each bar, estimate what fraction of the total bar length is filled with orange:
  - 0% filled (completely grey, no orange at all) → "empty"
  - ~25% filled (orange covers about 1/4 of the bar) → "low"
  - ~50% filled (orange covers about half the bar) → "mid"
  - ~75% filled (orange covers about 3/4 of the bar) → "high"
  - 100% filled (entirely orange, no grey visible) → "full"

IMPORTANT: Each bar is INDEPENDENT. Most bars will NOT be full. Look carefully at where the orange ends and grey begins for each bar.

Return ONLY: {"atk_bar": "...", "def_bar": "...", "sta_bar": "..."}`;

const PROMPT_WEATHER = `This is a zoomed grayscale crop of a Pokemon GO wild encounter banner showing the Pokemon name and CP number.

Look for a small WHITE circle with a KITE shape (diamond/rhombus with a tail pointing down) inside it. This circle appears directly above the last digit of the CP number.

Return ONLY this JSON: {"weather_boosted": true} if you see this white circle with a kite, or {"weather_boosted": false} if you do not see it.`;

const PROMPT_WILD = `Analyze this Pokemon GO screenshot showing a wild Pokemon encounter screen.

STEP 1 - pokemon: read the Pokemon name shown in the dark banner in the center of the screen (e.g. "Hoppip", "Pikachu", "Kyogre").

STEP 2 - cp: read the number next to "PC" or "CP" shown in that same banner. Return as integer only.

STEP 3 - weather_boosted: find the CP number (e.g. "502" or "146"). Look directly above the LAST DIGIT of that number. There may be a small circle with a WHITE background containing a KITE shape (a diamond/rhombus with a tail, like a flying kite toy) inside it. If you see this white circle with a kite inside above the last digit of the CP, return true. If there is no circle there, return false.

Return a JSON object with keys: pokemon, cp, weather_boosted.`;

const PROMPT = `Analyze this Pokemon GO screenshot showing a Pokemon's appraisal screen.

STEP 1 - pokemon: read the Pokemon name shown below its image.

STEP 2 - cp: read the large number next to "PC" or "CP" at the top. Return as integer only.

STEP 3 - stars: find the circular appraisal badge/medal. Count ONLY the SOLID FILLED gold stars (ignore hollow/grey stars). Return 0, 1, 2, or 3.

STEP 4 - IV bars: locate the appraisal popup panel with 3 horizontal bars labeled Ataque/Attack, Defensa/Defense, PS/Stamina.

Each bar is a horizontal rectangle divided into exactly 4 equal segments by small gaps. Filled segments are ORANGE/AMBER. Empty segments are LIGHT GREY.

For EACH bar, scan from LEFT to RIGHT and count how many orange segments you see:
  0 orange segments = "empty"
  1 orange segment  = "low"
  2 orange segments = "mid"
  3 orange segments = "high"
  4 orange segments = "full"

CRITICAL: Examine each bar INDEPENDENTLY. They will likely have DIFFERENT values. Do NOT assume all bars are the same. A shorter-looking bar does not mean fewer segments — look at the orange fill, not the total length.

STEP 5 - is_encounter: false if owned Pokemon, true if wild encounter.

STEP 6 - weather_boosted: in wild encounter screens, look for a small CIRCULAR ICON with a visible ring/border displayed near the CP number (usually to the left or above it). This circle contains a weather symbol inside and indicates weather boost. If you see this circular bordered icon near the CP, return true. If there is no such circle, return false.

Return a JSON object with keys: pokemon, cp, stars, atk_bar, def_bar, sta_bar, is_encounter, weather_boosted.`;

function extractJSON(txt) {
  const cleaned = txt
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error(`No JSON in response: "${txt.slice(0, 200)}"`);
}

// Round-robin counter shared across warm instances
let keyIndex = 0;

function getKeys(prefix) {
  const keys = [];
  if (process.env[prefix]) keys.push(process.env[prefix]);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`${prefix}_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

function nextKey(keys) {
  const key = keys[keyIndex % keys.length];
  keyIndex = (keyIndex + 1) % keys.length;
  return key;
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Request timed out after ${ms / 1000}s`);
      e.isOverload = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(model, image, mediaType, apiKey, prompt) {
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
            { text: prompt }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0,
          responseMimeType: "application/json"
        },
        thinkingConfig: { thinkingBudget: 0 }
      })
    },
    6000 // 6s per Gemini attempt
  );

  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    const isOverload = response.status === 503 ||
      response.status === 429 ||
      msg.toLowerCase().includes("high demand") ||
      msg.toLowerCase().includes("overloaded") ||
      msg.toLowerCase().includes("try again") ||
      msg.toLowerCase().includes("quota");
    const isUnavailable = msg.toLowerCase().includes("no longer available") ||
      msg.toLowerCase().includes("not found") ||
      msg.toLowerCase().includes("deprecated");
    const err = new Error(msg);
    err.isOverload = isOverload;
    err.isUnavailable = isUnavailable;
    throw err;
  }

  const txt = (data.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought)
    .map(p => p.text || "").join("").trim();

  return extractJSON(txt);
}

async function callGroq(model, image, mediaType, apiKey, prompt) {
  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType || "image/jpeg"};base64,${image}` }
            },
            { type: "text", text: prompt }
          ]
        }],
        response_format: { type: "json_object" },
        max_tokens: 300,
        temperature: 0
      })
    },
    10000 // 10s per Groq attempt
  );

  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    const isOverload = response.status === 503 ||
      response.status === 429 ||
      msg.toLowerCase().includes("rate limit") ||
      msg.toLowerCase().includes("overloaded");
    const err = new Error(msg);
    err.isOverload = isOverload;
    throw err;
  }

  const txt = data.choices?.[0]?.message?.content || "";
  return extractJSON(txt);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ status: "ok" });

  try {
    const { image, mediaType, mode } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const prompt = mode === "bars" ? PROMPT_BARS : mode === "weather" ? PROMPT_WEATHER : mode === "wild" ? PROMPT_WILD : PROMPT;

    const geminiKeys = getKeys("GEMINI_API_KEY");
    const groqKeys = getKeys("GROQ_API_KEY");

    if (geminiKeys.length === 0 && groqKeys.length === 0) {
      return res.status(500).json({ error: "No API keys configured" });
    }

    const errors = [];

    // 1. Try Gemini (all models x all keys)
    for (const model of GEMINI_MODELS) {
      for (let i = 0; i < geminiKeys.length; i++) {
        const apiKey = nextKey(geminiKeys);
        try {
          const result = await callGemini(model, image, mediaType, apiKey, prompt);
          return res.status(200).json(result);
        } catch (err) {
          errors.push(`[gemini/${model}] ${err.message}`);
          if (err.isUnavailable) break;
          if (err.isOverload) continue;
          break;
        }
      }
    }

    // 2. Fallback to Groq
    for (const model of GROQ_MODELS) {
      for (let i = 0; i < Math.max(groqKeys.length, 1); i++) {
        if (groqKeys.length === 0) break;
        const apiKey = nextKey(groqKeys);
        try {
          const result = await callGroq(model, image, mediaType, apiKey, prompt);
          return res.status(200).json(result);
        } catch (err) {
          errors.push(`[groq/${model}] ${err.message}`);
          if (err.isOverload) continue;
          break;
        }
      }
    }

    return res.status(503).json({
      error: "Service temporarily unavailable. Please try again in a moment.",
      details: errors
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
