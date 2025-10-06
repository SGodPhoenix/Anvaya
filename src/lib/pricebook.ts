// src/lib/pricebook.ts
// Loads & caches the MTM pricebook from a Google Sheet XLSX export.
// Adds a normalization layer so callers have stable keys.
import Constants from 'expo-constants';
import * as FS from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { parseXlsx, type XlsxRow } from './excel';
export type NormalizedRow = XlsxRow & {
  // UI-facing name (Column A)
  cf_item_name?: string;
  // Zoho catalog name (Column B)
  zoho_item_name?: string;
  // Zoho catalog id (Column K)
  zoho_item_id?: string;
  cf_size_1?: string;   // usually Column C
  cf_packing?: string;  // usually Column D
  default_qty?: number; // Column E
  nett_rate?: number;   // Column I
  exmill_rate?: number; // Column J
};
type PriceBook = {
  rows: NormalizedRow[];
  meta: {
    sourceUrl: string;
    cachedAt: string;
    cacheFile: string;
  };
};
const PRICEBOOK_URL: string =
  ((Constants?.expoConfig as any)?.extra?.MTM_PRICEBOOK_URL as string) ||
  (process.env as any)?.MTM_PRICEBOOK_URL ||
  '';
const CACHE_DIR = `${FS.cacheDirectory}pricebook/`;
const CACHE_JSON = `${CACHE_DIR}mtm_pricebook.json`;
async function ensureDir(dir: string) {
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) await FS.makeDirectoryAsync(dir, { intermediates: true });
}
async function readCached(): Promise<PriceBook | null> {
  const info = await FS.getInfoAsync(CACHE_JSON);
  if (!info.exists) return null;
  const txt = await FS.readAsStringAsync(CACHE_JSON);
  try { return JSON.parse(txt) as PriceBook; } catch { return null; }
}
/* --------------------- normalization helpers --------------------- */
export type PriceRow = NormalizedRow & {
  exmill?: number | null;
  nett?: number | null;
};
export function pickRate(
  row: PriceRow,
  priceList: 'Exmill' | 'Nett' | 'Manual' | '' | undefined,
  manualRate?: number
): number {
  const asNumber = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  if (priceList === 'Manual') {
    return typeof manualRate === 'number' && Number.isFinite(manualRate) ? manualRate : 0;
  }
  if (priceList === 'Nett') {
    return asNumber((row as any).nett ?? row.nett_rate);
  }
  if (priceList === 'Exmill') {
    return asNumber((row as any).exmill ?? row.exmill_rate);
  }
  return 0;
}
function normKey(k: string) {
  return k.toLowerCase().replace(/[\s\-_]+/g, '');
}
function toNum(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const cleaned = String(v).replace(/[^0-9.+-]/g, '');
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}
function pickKey(row: XlsxRow, ...candidates: (string | RegExp)[]): string | undefined {
  const keys = Object.keys(row || {});
  const table = new Map<string, string>();
  keys.forEach(k => table.set(normKey(k), k));
  for (const c of candidates) {
    if (typeof c === 'string') {
      const nk = normKey(c);
      if (table.has(nk)) return table.get(nk);
    } else {
      const found = keys.find(k => c.test(k));
      if (found) return found;
    }
  }
  return undefined;
}
function normalizeRow(r: XlsxRow): NormalizedRow {
  const out: NormalizedRow = { ...r };
  const kUi   = pickKey(r, 'cf_item_name', /cf.*item.*name/);
  const kName = pickKey(r, 'Item Name', /item.*name$/, /^name$/);
  const kId   = pickKey(r, 'Item ID', /item.*id/i, /^id$/i);
  const kSize = pickKey(r, 'cf_size_1', /^size$/, /size.*product/i);
  const kPack = pickKey(r, 'cf_packing', /^packing$/, /pack/i);
  const kQty  = pickKey(r, 'Quantity', 'Default Qty', /default.*qty/i, /^qty$/i, /^quantity$/i);
  const kNett = pickKey(r, 'Nett', /nett|net.*(rate|price)/i, /^net$/i);
  const kEx   = pickKey(r, 'Exmill', /ex[-_\s]?mill.*(rate|price)/i, /^ex[-_\s]?mill$/i);
  if (kUi)   out.cf_item_name  = String((r as any)[kUi]).trim();
  if (kName) out.zoho_item_name = String((r as any)[kName]).trim();
  if (kId)   out.zoho_item_id   = String((r as any)[kId]).trim();
  if (kSize) out.cf_size_1 = String((r as any)[kSize]).trim();
  if (kPack) out.cf_packing = String((r as any)[kPack]).trim();
  if (kQty)  out.default_qty = toNum((r as any)[kQty]);
  if (kNett) out.nett_rate   = toNum((r as any)[kNett]);
  if (kEx)   out.exmill_rate = toNum((r as any)[kEx]);
  return out;
}
/* ---------------------- fetch & cache normalized ---------------------- */
export async function refreshPriceBook(): Promise<PriceBook> {
  if (!PRICEBOOK_URL) throw new Error('Pricebook URL missing (MTM_PRICEBOOK_URL).');
  await ensureDir(CACHE_DIR);
  const raw = await parseXlsx(PRICEBOOK_URL);
  const rows = (raw || []).map(normalizeRow);
  const payload: PriceBook = {
    rows,
    meta: { sourceUrl: PRICEBOOK_URL, cachedAt: new Date().toISOString(), cacheFile: CACHE_JSON },
  };
  await FS.writeAsStringAsync(CACHE_JSON, JSON.stringify(payload));
  return payload;
}
export async function getPriceBook(): Promise<PriceBook> {
  const cached = await readCached();
  if (cached && cached.rows?.length) return cached;
  return await refreshPriceBook();
}
export async function getPriceRows(): Promise<NormalizedRow[]> {
  const pb = await getPriceBook();
  return pb.rows ?? [];
}
export async function shareCachedPriceBook(): Promise<void> {
  const cached = await readCached();
  const fileToShare = cached ? CACHE_JSON : (await refreshPriceBook(), CACHE_JSON);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(fileToShare);
  else throw new Error('Sharing not available on this device.');
}
export async function clearPriceBookCache(): Promise<void> {
  const info = await FS.getInfoAsync(CACHE_JSON);
  if (info.exists) await FS.deleteAsync(CACHE_JSON, { idempotent: true });
}
export const PricebookConfig = { URL: PRICEBOOK_URL, CACHE_JSON };
/* --------------------- legacy-compatible helpers --------------------- */
export async function loadCachedPriceBook(): Promise<NormalizedRow[]> {
  const cached = await readCached();
  if (cached?.rows) return cached.rows;
  if (!PRICEBOOK_URL) return [];
  const fresh = await refreshPriceBook();
  return fresh.rows ?? [];
}
export async function loadPriceBookRows(): Promise<NormalizedRow[]> { return getPriceRows(); }
export async function loadCachedPriceBookRows(): Promise<NormalizedRow[]> {
  const cached = await readCached();
  return cached?.rows ?? [];
}
export default {
  getPriceBook,
  getPriceRows,
  refreshPriceBook,
  shareCachedPriceBook,
  clearPriceBookCache,
  pickRate,
  PricebookConfig,
  loadCachedPriceBook,
  loadPriceBookRows,
  loadCachedPriceBookRows,
};
