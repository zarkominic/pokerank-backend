const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-8b",
  "gemini-2.5-pro",
];

const PROMPT = `Analyze this Pokemon GO screenshot showing a Pokemon's appraisal screen.

STEP 1 - pokemon: read the Pokemon name shown below its image.

STEP 2 - cp: read the large number next to "PC" or "CP" at the top. Return as integer only.

STEP 3 - stars: find the circular appraisal badge/medal. Count ONLY the SOLID FILLED gold stars (ignore hollow/grey stars). Return 0, 1, 2, or 3.

STEP 4 - IV bars: find the appraisal popup panel showing Attack/Ataque, Defense/Defensa, Stamina/PS bars. Each bar is divided into exactly 4 segments. Count the number of FILLED (orange/colored) segments for each bar:
  0 filled segments = "empty"
  1 filled segment  = "low"
  2 filled segments = "mid"
  3 filled segments = "high"
  4 filled segments = "full"

Count each bar INDEPENDENTLY — they WILL have different values. A short bar ≠ a long bar. Look carefully at each one.

STEP 5 - is_encounter: false if owned Pokemon, true if wild encounter.

Return a JSON object with keys: pokemon, cp, stars, atk_bar, def_bar, sta_bar, is_encounter.`;

function extractJSON(txt) {
  const cleaned = txt
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("No JSON in response");
}

// Round-robin counter shared across warm instances
let keyIndex = 0;

function getApiKeys() {
  const keys = [];
  // Support GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, ...
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

function nextKey(keys) {
  const key = keys[keyIndex % keys.length];
  keyIndex = (keyIndex + 1) % keys.length;
  return key;
}

async function callGemini(model, image, mediaType, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
            { text: PROMPT }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    }
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
    .map(p => p.text || "").join("").trim();

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
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const keys = getApiKeys();
    if (keys.length === 0) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

    const errors = [];

    for (const model of MODELS) {
      // Try each model — on overload rotate through all keys before giving up
      for (let attempt = 1; attempt <= keys.length * 2; attempt++) {
        const apiKey = nextKey(keys);
        try {
          const result = await callGemini(model, image, mediaType, apiKey);
          return res.status(200).json(result);
        } catch (err) {
          errors.push(`[${model}] ${err.message}`);
          if (err.isUnavailable) break; // Skip to next model immediately
          if (err.isOverload) {
            // Brief pause between key rotations, longer after full cycle
            const fullCycle = attempt % keys.length === 0;
            if (fullCycle && attempt < keys.length * 2) await sleep(1500);
            continue;
          }
          break; // Non-retriable error, try next model
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
