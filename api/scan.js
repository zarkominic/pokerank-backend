module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ status: "ok" });

  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
            { type: "text", text: 'Pokemon GO screenshot. Reply ONLY raw JSON: {"pokemon":"Name","cp":0,"stars":0,"atk_bar":"full","def_bar":"full","sta_bar":"full","is_encounter":false}' }
          ]
        }]
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data });
    const txt = (data.content || []).map(i => i.text || "").join("").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: "No JSON", raw: txt });
    return res.status(200).json(JSON.parse(m[0]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
