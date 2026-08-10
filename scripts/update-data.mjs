#!/usr/bin/env node
/**
 * מעדכן את הנתונים המוטמעים ב-personal-import-tax.html:
 *   1. טבלת המסים המרוכזת של רשות המסים (ConcentratedTaxesView)
 *   2. השערים היציגים של בנק ישראל (EDGE / SDMX)
 *
 * הנתונים נכתבים לתוך הקובץ עצמו (בין הסימונים EMBEDDED-DATA), כדי שהדף
 * יעבוד ללא שום קריאת רשת מהדפדפן — וכך אין בעיית CORS.
 *
 * לוגיקת הפענוח כאן מקבילה לזו שבדף (שם היא משמשת לרענון ידני מהדפדפן).
 * שינוי במבנה התשובה של אחד ה-APIs מחייב עדכון בשני המקומות.
 *
 * הרצה: node scripts/update-data.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = join(ROOT, "personal-import-tax.html");

const TAX_URL = "https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/SystemTables/api/GetTableData?tableName=ConcentratedTaxesView&includeMetadata=true";
const EDGE = "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/";
const RATE_URLS = [
  EDGE + "RER_USD_ILS+RER_EUR_ILS+RER_GBP_ILS?format=sdmx-json&lastNObservations=1",
  EDGE + "RER_USD_ILS?format=sdmx-json&lastNObservations=1",
  EDGE + "RER_EUR_ILS?format=sdmx-json&lastNObservations=1",
  EDGE + "RER_GBP_ILS?format=sdmx-json&lastNObservations=1",
  EDGE + "all?format=sdmx-json&lastNObservations=1",
  "https://boi.org.il/PublicApi/GetExchangeRates?asJson=true"
];

const COLS = ["l1", "l2", "l3", "t1", "t2", "t3", "t4", "note"];
const FIELDS = {
  productlevel1:"l1", productlevel2:"l2", productlevel3:"l3",
  category1taxes1:"t1", category1taxes2:"t2", category1taxes3:"t3", category1taxes4:"t4",
  specialremarkforpassengerterminal:"note"
};

const warn = m => console.log("::warning::" + m);
const keyNorm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

function clean(v){
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/[״“”]/g, '"')
    .replace(/[׳‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------- הבאת נתונים ------------------------------- */

async function fetchJson(url, tries = 3){
  for (let i = 0; i < tries; i++){
    try{
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "personal-import-tax-calculator/1.0" },
        signal: AbortSignal.timeout(45000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return JSON.parse(await res.text());
    }catch(e){
      const last = i === tries - 1;
      console.log(`  ניסיון ${i + 1}/${tries} נכשל: ${e.message}${last ? "" : " — מנסה שוב"}`);
      if (!last) await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i)));
    }
  }
  return null;
}

/* --------------------------- טבלת המסים המרוכזת --------------------------- */

function scoreRow(row){
  if (!row || typeof row !== "object" || Array.isArray(row)) return -1;
  return Object.keys(row).filter(k => FIELDS[keyNorm(k)]).length;
}

function findRows(json){
  const seen = new Set(); const queue = [json]; let best = null;
  while (queue.length){
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)){
      if (cur.length && cur.every(x => x && typeof x === "object")){
        const score = scoreRow(cur[0]);
        if (!best || score > best.score || (score === best.score && cur.length > best.rows.length)) best = {score, rows:cur};
      }
      for (const x of cur.slice(0, 5)) queue.push(x);
    } else {
      for (const v of Object.values(cur)) queue.push(v);
    }
  }
  return best ? best.rows : [];
}

function findColumns(json, len){
  const seen = new Set(); const queue = [json];
  while (queue.length){
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur) && cur.length === len){
      if (cur.every(x => typeof x === "string")) return cur;
      if (cur.every(x => x && typeof x === "object")){
        const names = cur.map(x => {
          for (const k of ["name","Name","columnName","ColumnName","field","Field","fieldName","key","id","Id"]){
            if (typeof x[k] === "string") return x[k];
          }
          return "";
        });
        if (names.every(Boolean)) return names;
      }
    }
    const vals = Array.isArray(cur) ? cur.slice(0, 5) : Object.values(cur);
    for (const v of vals) queue.push(v);
  }
  return null;
}

function findArrayOfArrays(json){
  const seen = new Set(); const queue = [json]; let best = null;
  while (queue.length){
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)){
      if (cur.length && cur.every(x => Array.isArray(x)) && (!best || cur.length > best.length)) best = cur;
      for (const x of cur.slice(0, 5)) queue.push(x);
    } else {
      for (const v of Object.values(cur)) queue.push(v);
    }
  }
  return best;
}

// נשמרת כל שורה שיש לה קטגוריה ראשית, גם אם חסרים בה נתוני מס —
// עדיף שהמוצר יופיע במחשבון ויציג "אין נתון" מאשר שייעלם בשקט.
function mapRecords(rows){
  if (!rows || !rows.length || Array.isArray(rows[0])) return [];
  const out = [];
  const noTax = [];
  let dropped = 0;
  for (const r of rows){
    const rec = {};
    for (const [k, v] of Object.entries(r)){
      const c = FIELDS[keyNorm(k)];
      if (c) rec[c] = clean(v);
    }
    if (rec.l1) out.push(rec); else dropped++;
    if (rec.l1 && !rec.t1 && !rec.t2 && !rec.t3 && !rec.t4 && noTax.length < 2) noTax.push(r);
  }
  if (rows.length){
    console.log(`  שורות גולמיות: ${rows.length} | נשמרו: ${out.length} | ללא קטגוריה ראשית: ${dropped}`);
    // אבחון: אילו שדות בכלל קיימים בשורות שאין להן נתוני מס בעמודות Category1
    if (noTax.length) console.log("  דוגמה לשורה ללא נתוני מס:\n    " + JSON.stringify(noTax[0]));
  }
  return out;
}

function extractRecords(json){
  let recs = mapRecords(findRows(json));
  if (recs.length) return recs;
  const arr = findArrayOfArrays(json);
  if (arr){
    const cols = findColumns(json, arr[0].length);
    if (cols) recs = mapRecords(arr.map(r => { const o = {}; cols.forEach((c,i) => o[c] = r[i]); return o; }));
  }
  return recs;
}

/* ------------------------- שערים יציגים — בנק ישראל ------------------------- */

function currencyFromCode(id){
  const c = String(id || "").toUpperCase().replace(/ILS|NIS/g, "");
  if (/USD/.test(c)) return "USD";
  if (/EUR/.test(c)) return "EUR";
  if (/GBP/.test(c)) return "GBP";
  return null;
}

function parseSdmxRates(json){
  const out = {};
  const msg = (json && json.data && (json.data.dataSets || json.data.structure || json.data.structures)) ? json.data : json;
  if (!msg || typeof msg !== "object") return out;
  const structure = msg.structure || (Array.isArray(msg.structures) && msg.structures[0]) || json.structure;
  const dataSets = msg.dataSets || msg.dataSet || [];
  if (!structure || !dataSets.length) return out;

  const dims = (structure.dimensions && structure.dimensions.series) || [];
  const obsDims = (structure.dimensions && structure.dimensions.observation) || [];
  const timeVals = (obsDims[0] && obsDims[0].values) || [];

  for (const ds of [].concat(dataSets)){
    const series = ds && ds.series;
    if (!series) continue;
    for (const [key, s] of Object.entries(series)){
      const ids = [];
      key.split(":").map(Number).forEach((v, i) => {
        const vals = dims[i] && dims[i].values;
        if (vals && vals[v] && vals[v].id) ids.push(String(vals[v].id));
      });
      const cur = currencyFromCode(ids.join("_"));
      if (!cur) continue;
      const exact = ids.some(id => new RegExp("^RER_" + cur + "_ILS$", "i").test(id));
      if (out[cur] && out[cur].exact && !exact) continue;

      const obs = s.observations || {};
      const oKeys = Object.keys(obs).sort((a,b) => Number(a) - Number(b));
      if (!oKeys.length) continue;
      const lastKey = oKeys[oKeys.length - 1];
      const cell = obs[lastKey];
      const val = Number(Array.isArray(cell) ? cell[0] : cell);
      if (!isFinite(val) || val <= 0) continue;
      const t = timeVals[Number(lastKey)];
      out[cur] = { rate: val, date: t ? String(t.id || t.name || "") : "", exact };
    }
  }
  return out;
}

function parseLegacyRates(json){
  const out = {};
  const seen = new Set(); const queue = [json];
  while (queue.length){
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (!Array.isArray(cur)){
      let code = null, rate = null, rateScore = 0, unit = 1, date = "";
      for (const [k, v] of Object.entries(cur)){
        const nk = keyNorm(k);
        if (!code && (nk === "key" || nk === "currencycode" || nk === "currency") && typeof v === "string") code = currencyFromCode(v);
        const score = /exchangerate/.test(nk) ? 3
          : (nk === "rate" || nk === "currentrate" || nk === "value") ? 2
          : (/rate/.test(nk) && !/change|percent/.test(nk)) ? 1 : 0;
        if (score > rateScore && Number(v) > 0 && isFinite(Number(v))){ rate = Number(v); rateScore = score; }
        if (nk === "unit" && Number(v) > 0) unit = Number(v);
        if (/lastupdate|date/.test(nk) && typeof v === "string") date = v.slice(0, 10);
      }
      if (code && rate > 0) out[code] = { rate: rate / unit, date, exact:true };
    }
    const vals = Array.isArray(cur) ? cur : Object.values(cur);
    for (const v of vals) queue.push(v);
  }
  return out;
}

async function fetchRates(){
  const found = {};
  for (const url of RATE_URLS){
    if (found.USD && found.EUR && found.GBP) break;
    console.log("שערים: " + url.replace(/\?.*/, ""));
    const json = await fetchJson(url, 2);
    if (!json) continue;
    const parsed = /PublicApi/.test(url) ? parseLegacyRates(json) : parseSdmxRates(json);
    for (const [k, v] of Object.entries(parsed)) if (!found[k]) found[k] = v;
  }
  return found;
}

/* ------------------------------ בנייה והטמעה ------------------------------ */

// דחיסה: טבלת מחרוזות ייחודיות + שורות של אינדקסים (הרבה ערכים חוזרים)
function packRecords(records){
  const index = new Map(); const strings = [];
  const idx = s => {
    const v = s || "";
    if (!index.has(v)){ index.set(v, strings.length); strings.push(v); }
    return index.get(v);
  };
  const rows = records.map(r => COLS.map(c => idx(r[c])));
  return { cols: COLS, strings, rows };
}

function readEmbedded(html){
  const m = html.match(/<!-- EMBEDDED-DATA:START -->[\s\S]*?<script type="application\/json" id="embeddedData">([\s\S]*?)<\/script>[\s\S]*?<!-- EMBEDDED-DATA:END -->/);
  if (!m) return null;
  try{ return JSON.parse(m[1].replace(/\\u003c/g, "<")); }catch(e){ return null; }
}

function writeEmbedded(html, data){
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const block = '<!-- EMBEDDED-DATA:START -->\n<script type="application/json" id="embeddedData">' + json +
    '</script>\n<!-- EMBEDDED-DATA:END -->';
  const re = /<!-- EMBEDDED-DATA:START -->[\s\S]*?<!-- EMBEDDED-DATA:END -->/;
  if (!re.test(html)) throw new Error("לא נמצאו סימוני EMBEDDED-DATA בקובץ ה-HTML");
  return html.replace(re, () => block);
}

async function main(){
  const html = await readFile(HTML_PATH, "utf8");
  const prev = readEmbedded(html) || {};
  let failed = 0;

  console.log("מושך את טבלת המסים המרוכזת…");
  const taxJson = await fetchJson(TAX_URL);
  let packed = prev.cols ? { cols: prev.cols, strings: prev.strings, rows: prev.rows } : null;
  if (taxJson){
    const records = extractRecords(taxJson);
    if (records.length){
      packed = packRecords(records);
      console.log(`  נמצאו ${records.length} רשומות, ${packed.strings.length} מחרוזות ייחודיות`);
    }else{
      failed++;
      warn("מבנה התשובה של טבלת המסים לא זוהה — נשמרים הנתונים הקודמים");
    }
  }else{
    failed++;
    warn("לא ניתן היה למשוך את טבלת המסים — נשמרים הנתונים הקודמים");
  }

  console.log("מושך שערים יציגים מבנק ישראל…");
  const found = await fetchRates();
  let rates = prev.rates || null;
  if (found.USD){
    rates = { date: (found.USD.date || found.EUR?.date || found.GBP?.date || "") };
    for (const c of ["USD","EUR","GBP"]) if (found[c]) rates[c] = Math.round(found[c].rate * 10000) / 10000;
    console.log("  " + JSON.stringify(rates));
    if (!found.EUR || !found.GBP) warn("חלק מהשערים לא נמצאו: " + ["EUR","GBP"].filter(c => !found[c]).join(", "));
  }else{
    failed++;
    warn("לא ניתן היה למשוך שערים מבנק ישראל — נשמרים השערים הקודמים");
  }

  if (!packed || !packed.rows || !packed.rows.length){
    console.error("שגיאה: אין נתוני מסים כלל (לא חדשים ולא קודמים).");
    process.exit(1);
  }

  const data = {
    updated: new Date().toISOString().slice(0, 10),
    cols: packed.cols, strings: packed.strings, rows: packed.rows,
    rates: rates || undefined
  };
  await writeFile(HTML_PATH, writeEmbedded(html, data), "utf8");
  console.log(`הקובץ עודכן (${data.rows.length} רשומות, ${(JSON.stringify(data).length / 1024).toFixed(0)}KB).`);
  if (failed) warn(`${failed} מקורות נכשלו — נעשה שימוש בנתונים הקודמים עבורם.`);
}

main().catch(e => { console.error(e); process.exit(1); });
