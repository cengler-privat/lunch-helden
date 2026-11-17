/**
 * Lokaler Entwicklungs- & Test-Server (server.js)
 * Startet die Web-App auf http://localhost:3000 UND stellt lokal den
 * KI-Foto-Scanner-Endpunkt POST /api/scan-menu bereit (nutzt direkt die .env).
 */

import dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://hskgtyticqtrsalcslmr.supabase.co').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

async function handleScanMenu(req, res) {
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
  }

  try {
    const { restaurant_id, wirt_pin, image_base64, mime_type } = JSON.parse(rawBody || '{}');
    if (!restaurant_id || !wirt_pin || !image_base64) {
      return sendJson(res, 400, { error: 'Pflichtfelder fehlen (restaurant_id, wirt_pin, image_base64).' });
    }

    // 1. Restaurant & Wirt-PIN prüfen
    const { data: restaurant, error: restError } = await supabase
      .from('restaurants')
      .select('id, name, wirt_pin')
      .eq('id', restaurant_id)
      .single();

    if (restError || !restaurant) {
      return sendJson(res, 404, { error: 'Restaurant wurde nicht gefunden.' });
    }

    if (String(restaurant.wirt_pin).trim().toUpperCase() !== String(wirt_pin).trim().toUpperCase()) {
      return sendJson(res, 401, { error: 'Ungültige Wirt-PIN. Bitte prüfe deine Zugangsdaten.' });
    }

    // 2. Foto per @google/genai analysieren (mit automatischem Modell-Fallback)
    const prompt =
      'Lies alle Tagesgerichte oder Mittagsangebote von diesem Foto einer Speisekarte/Tafel aus. ' +
      'Extrahiere ausschließlich sachliche Fakten (Name des Gerichts, Wochentag falls angegeben sonst "Heute", Preis in Euro als Zahl, und ob das Gericht vegetarisch ist).';

    const modelsToTry = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
    let extractedDishes = [];
    let lastErr = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`📸 Analysiere Foto für "${restaurant.name}" mit ${modelName}…`);
        const aiResp = await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: mime_type || 'image/jpeg',
                    data: image_base64,
                  },
                },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  day: { type: Type.STRING },
                  title: { type: Type.STRING },
                  price: { type: Type.NUMBER },
                  is_vegetarian: { type: Type.BOOLEAN },
                },
                required: ['day', 'title', 'price', 'is_vegetarian'],
              },
            },
          },
        });
        extractedDishes = JSON.parse(aiResp.text || '[]');
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`⚠️ Modell ${modelName} fehlgeschlagen, probiere nächstes…`, err.message);
      }
    }

    if (!Array.isArray(extractedDishes) || extractedDishes.length === 0) {
      return sendJson(res, 422, {
        error: `Keine Gerichte erkannt (${lastErr ? lastErr.message : 'Leere Antwort'}).`,
      });
    }

    // 3. In Supabase speichern
    await supabase.from('dishes').delete().eq('restaurant_id', restaurant_id);

    const rowsToInsert = extractedDishes.map((d) => ({
      restaurant_id: Number(restaurant_id),
      day: d.day || 'Heute',
      title: String(d.title).trim(),
      price: Number(d.price) || 0,
      is_vegetarian: Boolean(d.is_vegetarian),
      updated_at: new Date().toISOString(),
    }));

    const { data: insertedDishes, error: insertError } = await supabase
      .from('dishes')
      .insert(rowsToInsert)
      .select();

    if (insertError) throw insertError;

    console.log(`✅ ${insertedDishes.length} Gerichte für "${restaurant.name}" live in Supabase gespeichert!`);
    return sendJson(res, 200, {
      success: true,
      restaurant: restaurant.name,
      dishes: insertedDishes,
    });
  } catch (err) {
    console.error('❌ Fehler beim lokalen Foto-Scan:', err);
    return sendJson(res, 500, { error: err.message || 'Unbekannter Serverfehler' });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  // Lokaler API-Endpunkt für den KI-Foto-Scanner
  if (req.method === 'POST' && urlObj.pathname === '/api/scan-menu') {
    return handleScanMenu(req, res);
  }

  // Statische Dateien ausliefern
  let safePath = path.normalize(decodeURIComponent(urlObj.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';

  const filePath = path.join(__dirname, safePath);
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n🚀 Lunch-Helden Lokal-Server läuft auf: http://localhost:${PORT}`);
  console.log(`📸 KI-Foto-Scanner (Wirt-Modus) aktiv unter: http://localhost:${PORT}/api/scan-menu`);
  console.log(`🔑 Wirt-PINs zum Testen: Metzgerei Back = B4K92, Tournedo = T7R48, Kurpfalz-Café = K3C85\n`);
});
