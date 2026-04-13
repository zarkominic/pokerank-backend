const PROMPT = `Analyze this Pokemon GO screenshot showing a Pokemon's appraisal screen.

STEP 1 - pokemon: read the Pokemon name shown below its image.

STEP 2 - cp: read the large number next to "PC" or "CP" at the top. Return as integer only.

STEP 3 - stars: find the circular appraisal badge/medal. Count ONLY the SOLID FILLED gold stars (ignore hollow/grey stars). Return 0, 1, 2, or 3.

STEP 4 - IV bars: find the appraisal panel with 3 horizontal orange bars labeled Attack/Ataque, Defense/Defensa, Stamina/PS. For EACH bar independently estimate the fill:
  "empty" = 0% filled
  "low"   = ~25% filled (about 1 of 4 segments)
  "mid"   = ~50% filled (about 2 of 4 segments)
  "high"  = ~75% filled (about 3 of 4 segments)
  "full"  = 100% completely filled

WARNING: Each bar has a DIFFERENT fill level. Examine each one individually.

STEP 5 - is_encounter: false if owned Pokemon, true if wild encounter.

Return a JSON object with keys: pokemon, cp, stars, atk_bar, def_bar, sta_bar, is_encounter.`;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ status: "ok" });

  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
      return res.status(500).json({ error: msg });
    }

    const txt = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "").join("").trim();

    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: "No JSON in response", raw: txt });

    return res.status(200).json(JSON.parse(m[0]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
