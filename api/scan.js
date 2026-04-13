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

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pokerank-backend.vercel.app",
        "X-Title": "PokeRank GO"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.2-11b-vision-instruct:free",
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType || "image/jpeg"};base64,${image}` }
            },
            {
              type: "text",
              text: 'Pokemon GO screenshot. Reply ONLY raw JSON, no markdown, no extra text: {"pokemon":"Name","cp":0,"stars":0,"atk_bar":"full","def_bar":"full","sta_bar":"full","is_encounter":false}'
            }
          ]
        }],
        max_tokens: 300,
        temperature: 0
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      return res.status(500).json({ error: msg });
    }

    const txt = (data.choices?.[0]?.message?.content || "").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: "No JSON in response", raw: txt });
    return res.status(200).json(JSON.parse(m[0]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
