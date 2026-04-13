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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
              { text: 'Pokemon GO screenshot. Reply ONLY raw JSON, no markdown: {"pokemon":"Name","cp":0,"stars":0,"atk_bar":"full","def_bar":"full","sta_bar":"full","is_encounter":false}' }
            ]
          }],
          generationConfig: { maxOutputTokens: 300, temperature: 0 }
        }),
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
