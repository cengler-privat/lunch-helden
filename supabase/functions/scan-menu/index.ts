// ============================================================================
// Supabase Edge Function: scan-menu (Zero-Dependency Version gegen Status 546)
// Pfad: supabase/functions/scan-menu/index.ts
// Beschreibung: Nutzt reines fetch() für Supabase REST & Google Gemini API,
// damit kein schweres npm-SDK das RAM-/CPU-Limit (HTTP 546) von Supabase sprengt.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceRoleKey || !geminiApiKey) {
      return new Response(
        JSON.stringify({ error: "Server-Konfiguration unvollständig (SUPABASE / GEMINI Keys fehlen)." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { restaurant_id, wirt_pin, image_base64, mime_type } = body;

    if (!restaurant_id || !wirt_pin || !image_base64) {
      return new Response(
        JSON.stringify({ error: "Pflichtfelder fehlen (restaurant_id, wirt_pin, image_base64)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sbHeaders = {
      "apikey": supabaseServiceRoleKey,
      "Authorization": `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    };

    // 1. Restaurant & Wirt-PIN über schlanke Supabase REST-API prüfen
    const restLookup = await fetch(
      `${supabaseUrl}/rest/v1/restaurants?id=eq.${encodeURIComponent(String(restaurant_id))}&select=id,name,wirt_pin`,
      { headers: sbHeaders }
    );
    const restRows = await restLookup.json();
    const restaurant = Array.isArray(restRows) ? restRows[0] : null;

    if (!restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurant wurde nicht gefunden." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (String(restaurant.wirt_pin).trim() !== String(wirt_pin).trim()) {
      return new Response(
        JSON.stringify({ error: "Ungültige Wirt-PIN. Bitte prüfe deine Zugangsdaten." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Foto direkt per schlankem Gemini REST-Call analysieren (verhindert Status 546)
    const prompt =
      "Lies alle Tagesgerichte oder Mittagsangebote von diesem Foto einer Speisekarte/Tafel aus. " +
      "Extrahiere ausschließlich sachliche Fakten als JSON-Array von Objekten mit den Feldern: " +
      'day (Wochentag oder "Heute"), title (Name des Gerichts), price (Preis in Euro als Dezimalzahl), is_vegetarian (true/false).';

    const modelsToTry = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
    let extractedDishes: Array<{
      day?: string;
      title: string;
      price: number;
      is_vegetarian?: boolean;
    }> = [];
    let lastError = "Keine Antwort von Gemini";

    for (const modelName of modelsToTry) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
      const geminiResp = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: mime_type || "image/jpeg",
                    data: image_base64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  day: { type: "STRING" },
                  title: { type: "STRING" },
                  price: { type: "NUMBER" },
                  is_vegetarian: { type: "BOOLEAN" },
                },
                required: ["day", "title", "price", "is_vegetarian"],
              },
            },
          },
        }),
      });

      if (geminiResp.ok) {
        const geminiData = await geminiResp.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
        extractedDishes = JSON.parse(rawText);
        break;
      } else {
        lastError = await geminiResp.text();
      }
    }

    if (!Array.isArray(extractedDishes) || extractedDishes.length === 0) {
      return new Response(
        JSON.stringify({ error: `Es konnten keine Gerichte erkannt werden (${lastError.slice(0, 160)}).` }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Alte Gerichte löschen & neue Gerichte per Supabase REST speichern
    await fetch(
      `${supabaseUrl}/rest/v1/dishes?restaurant_id=eq.${encodeURIComponent(String(restaurant_id))}`,
      { method: "DELETE", headers: sbHeaders }
    );

    const rowsToInsert = extractedDishes.map((d) => ({
      restaurant_id: Number(restaurant_id),
      day: d.day || "Heute",
      title: String(d.title).trim(),
      price: Number(d.price) || 0,
      is_vegetarian: Boolean(d.is_vegetarian),
      updated_at: new Date().toISOString(),
    }));

    const insertResp = await fetch(`${supabaseUrl}/rest/v1/dishes`, {
      method: "POST",
      headers: { ...sbHeaders, "Prefer": "return=representation" },
      body: JSON.stringify(rowsToInsert),
    });

    if (!insertResp.ok) {
      const errText = await insertResp.text();
      throw new Error(`Supabase Insert Fehler: ${errText}`);
    }

    const insertedDishes = await insertResp.json();

    return new Response(
      JSON.stringify({
        success: true,
        restaurant: restaurant.name,
        dishes: insertedDishes,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unbekannter Fehler";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
