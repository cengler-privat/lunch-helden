// ============================================================================
// Supabase Edge Function: scan-menu
// Pfad: supabase/functions/scan-menu/index.ts
// Beschreibung: Prüft die wirt_pin des gewählten Restaurants, analysiert das
// hochgeladene Foto der Tages-/Wochenkarte mit @google/genai (inkl. Modell-Fallback)
// und aktualisiert automatisch die Tabelle `dishes`.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenAI, Type } from "npm:@google/genai";

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
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

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    // 1. Restaurant & Wirt-PIN prüfen
    const { data: restaurant, error: restError } = await supabase
      .from("restaurants")
      .select("id, name, wirt_pin")
      .eq("id", restaurant_id)
      .single();

    if (restError || !restaurant) {
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

    // 2. Foto per @google/genai (inkl. Modell-Fallback bei 503-Spikes) auslesen
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const prompt = `
      Lies alle Tagesgerichte oder Mittagsangebote von diesem Foto einer Speisekarte/Tafel aus.
      Extrahiere ausschließlich sachliche Fakten (Name des Gerichts, Wochentag falls angegeben sonst "Heute", Preis in Euro als Zahl, und ob das Gericht vegetarisch ist).
    `;

    const modelsToTry = [
      Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
    ];

    let extractedDishes: Array<{
      day?: string;
      title: string;
      price: number;
      is_vegetarian?: boolean;
    }> = [];
    let lastError: unknown = null;

    for (const modelName of modelsToTry) {
      try {
        const aiResponse = await ai.models.generateContent({
          model: modelName,
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
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  day: { type: Type.STRING, description: "Wochentag oder 'Heute'" },
                  title: { type: Type.STRING, description: "Name des Tagesgerichts" },
                  price: { type: Type.NUMBER, description: "Preis in Euro als Dezimalzahl" },
                  is_vegetarian: { type: Type.BOOLEAN, description: "True wenn vegetarisch" },
                },
                required: ["day", "title", "price", "is_vegetarian"],
              },
            },
          },
        });
        extractedDishes = JSON.parse(aiResponse.text || "[]");
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (extractedDishes.length === 0 && lastError) {
      throw lastError;
    }

    if (!Array.isArray(extractedDishes) || extractedDishes.length === 0) {
      return new Response(
        JSON.stringify({ error: "Es konnten keine Gerichte auf dem Foto erkannt werden." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Alte Gerichte des Restaurants ersetzen & neue Gerichte speichern
    await supabase.from("dishes").delete().eq("restaurant_id", restaurant_id);

    const rowsToInsert = extractedDishes.map((d: {
      day?: string;
      title: string;
      price: number;
      is_vegetarian?: boolean;
    }) => ({
      restaurant_id: Number(restaurant_id),
      day: d.day || "Heute",
      title: String(d.title).trim(),
      price: Number(d.price) || 0,
      is_vegetarian: Boolean(d.is_vegetarian),
      updated_at: new Date().toISOString(),
    }));

    const { data: insertedDishes, error: insertError } = await supabase
      .from("dishes")
      .insert(rowsToInsert)
      .select();

    if (insertError) {
      throw insertError;
    }

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
