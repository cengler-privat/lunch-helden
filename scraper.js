/**
 * Lunch-Helden – Automatischer Montags-Scraper (scraper.js)
 * Liest öffentliche Wochenkarten (HTML & PDF) der eingetragenen Restaurants
 * unter strikter Beachtung der robots.txt aus, extrahiert mit @google/genai
 * (gemini-2.5-flash) die reinen Fakten (Gericht, Tag, Preis, Vegetarisch)
 * und aktualisiert die Tabelle `dishes` in Supabase.
 */

import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import robotsParser from 'robots-parser';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  console.error('❌ Fehlende Umgebungsvariablen: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY oder GEMINI_API_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const USER_AGENT = 'LunchHeldenBot/1.0 (+https://cengler-privat.github.io/lunch-helden/)';

/**
 * Prüft die robots.txt der Ziel-Domain vor dem Abruf.
 */
async function isAllowedByRobots(targetUrl) {
  try {
    const parsedUrl = new URL(targetUrl);
    const robotsUrl = `${parsedUrl.origin}/robots.txt`;
    const response = await axios.get(robotsUrl, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: (status) => status < 500,
    });

    if (response.status === 200 && typeof response.data === 'string') {
      const robots = robotsParser(robotsUrl, response.data);
      return robots.isAllowed(targetUrl, USER_AGENT) !== false;
    }
    return true;
  } catch {
    // Wenn keine robots.txt erreichbar ist, ist öffentlicher Abruf erlaubt
    return true;
  }
}

/**
 * Lädt den Rohtext einer Restaurant-Website (HTML oder verlinktes PDF).
 */
async function fetchMenuRawText(websiteUrl) {
  const allowed = await isAllowedByRobots(websiteUrl);
  if (!allowed) {
    console.warn(`⚠️ Überspringe ${websiteUrl} (laut robots.txt nicht freigegeben).`);
    return null;
  }

  const response = await axios.get(websiteUrl, {
    timeout: 15000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': USER_AGENT },
  });

  const contentType = (response.headers['content-type'] || '').toLowerCase();

  // Fall A: Direktes PDF-Dokument
  if (contentType.includes('application/pdf') || websiteUrl.toLowerCase().endsWith('.pdf')) {
    const pdfData = await pdfParse(Buffer.from(response.data));
    return pdfData.text;
  }

  // Fall B: HTML-Seite parsen (und ggf. auf ein verlinktes Wochenkarten-PDF prüfen)
  const html = Buffer.from(response.data).toString('utf-8');
  const $ = cheerio.load(html);

  let pdfLink = null;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().toLowerCase();
    if (
      href.toLowerCase().endsWith('.pdf') &&
      (text.includes('mittag') || text.includes('woche') || text.includes('tageskarte') || href.toLowerCase().includes('mittag'))
    ) {
      pdfLink = new URL(href, websiteUrl).toString();
    }
  });

  if (pdfLink && (await isAllowedByRobots(pdfLink))) {
    try {
      const pdfResp = await axios.get(pdfLink, {
        timeout: 15000,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
      });
      const pdfData = await pdfParse(Buffer.from(pdfResp.data));
      if (pdfData.text && pdfData.text.trim().length > 40) {
        return pdfData.text;
      }
    } catch (pdfErr) {
      console.warn(`PDF-Abruf für ${pdfLink} fehlgeschlagen, nutze HTML-Text:`, pdfErr.message);
    }
  }

  $('script, style, noscript, svg, footer, nav').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 12000);
}

/**
 * Extrahiert Tagesgerichte mithilfe von Gemini 2.5 Flash als strukturiertes JSON.
 */
async function extractDishesWithGemini(restaurantName, rawText) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `
      Du analysierst den öffentlichen Speisekarten-Text von "${restaurantName}".
      Extrahiere alle aktuellen Mittagsgerichte / Tagesgerichte als Liste von Fakten (keine werblichen Beschreibungen kopieren).
      Text:
      ${rawText}
    `,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            day: { type: Type.STRING, description: 'Wochentag (z. B. Montag, Dienstag oder Heute)' },
            title: { type: Type.STRING, description: 'Sachliche Bezeichnung des Tagesgerichts' },
            price: { type: Type.NUMBER, description: 'Preis in Euro als Zahl' },
            is_vegetarian: { type: Type.BOOLEAN, description: 'True falls vegetarisch' },
          },
          required: ['day', 'title', 'price', 'is_vegetarian'],
        },
      },
    },
  });

  return JSON.parse(response.text || '[]');
}

async function runWeeklyScrape() {
  console.log('🚀 Starte wöchentlichen Lunch-Helden Scraper…');

  const { data: restaurants, error } = await supabase
    .from('restaurants')
    .select('id, name, city, website_url')
    .order('id', { ascending: true });

  if (error) {
    console.error('❌ Fehler beim Laden der Restaurants aus Supabase:', error.message);
    process.exit(1);
  }

  for (const restaurant of restaurants || []) {
    console.log(`\n🔍 Prüfe ${restaurant.name} (${restaurant.city}) -> ${restaurant.website_url}`);
    try {
      const rawText = await fetchMenuRawText(restaurant.website_url);
      if (!rawText || rawText.length < 30) {
        console.log(`ℹ️ Kein verwertbarer Speisekartentext für ${restaurant.name} gefunden.`);
        continue;
      }

      const dishes = await extractDishesWithGemini(restaurant.name, rawText);
      if (!Array.isArray(dishes) || dishes.length === 0) {
        console.log(`ℹ️ Keine neuen Tagesgerichte auf der Seite von ${restaurant.name} erkannt.`);
        continue;
      }

      await supabase.from('dishes').delete().eq('restaurant_id', restaurant.id);

      const rows = dishes.map((d) => ({
        restaurant_id: restaurant.id,
        day: d.day || 'Heute',
        title: String(d.title).trim(),
        price: Number(d.price) || 0,
        is_vegetarian: Boolean(d.is_vegetarian),
        updated_at: new Date().toISOString(),
      }));

      const { error: insertError } = await supabase.from('dishes').insert(rows);
      if (insertError) {
        console.error(`❌ Fehler beim Speichern für ${restaurant.name}:`, insertError.message);
      } else {
        console.log(`✅ ${rows.length} Tagesgerichte für ${restaurant.name} erfolgreich gespeichert.`);
      }
    } catch (err) {
      console.warn(`⚠️ Konnte ${restaurant.name} nicht automatisch auslesen: ${err.message}`);
    }
  }

  console.log('\n🎉 Wöchentlicher Scraper-Lauf abgeschlossen.');
}

runWeeklyScrape();
