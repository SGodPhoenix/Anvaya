// src/lib/zoho.ts
import Constants from 'expo-constants';
import * as FS from 'expo-file-system/legacy';  // expo legacy API keeps document/cache + SAF helpers
import { fromByteArray } from 'base64-js';
import { Platform } from 'react-native';

import { mergePdfBytes } from './pdf';
import { ensureDir, uniqueName } from './utils';

const ACCOUNTS_BASE = 'https://accounts.zoho.in';
const BOOKS_BASE = 'https://www.zohoapis.in/books/v3';

export type OrgKey = 'PM' | 'MTM' | 'RMD' | 'MURLI';
export const ORGS: { key: OrgKey; name: string }[] = [
  { key: 'PM', name: 'Pashupati Marketing' },
  { key: 'MTM', name: 'Morvinandan Textile Mills' },
  { key: 'RMD', name: 'RMD' },
  { key: 'MURLI', name: 'Murli' },
];

type OrgCfg = { REFRESH?: string; CLIENT_ID?: string; CLIENT_SECRET?: string; ORG?: string };
function cfg(org: OrgKey): OrgCfg {
  const z = (Constants?.expoConfig as any)?.extra?.ZOHO;
  return z?.[org] || {};
}

async function getAccessToken(org: OrgKey, log?: (s: string) => void): Promise<string> {
  const { REFRESH, CLIENT_ID, CLIENT_SECRET } = cfg(org);
  if (!REFRESH || !CLIENT_ID || !CLIENT_SECRET) throw new Error(`Missing secrets for ${org}`);
  const params = new URLSearchParams({
    refresh_token: REFRESH,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const url = `${ACCOUNTS_BASE}/oauth/v2/token?${params.toString()}`;
  log?.('Auth...');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`Token error ${r.status}`);
  const j = await r.json();
  return j.access_token as string;
}

function orgId(org: OrgKey): string {
  const viaCfg = cfg(org).ORG;
  if (viaCfg) return viaCfg;

  const extra = ((Constants as any)?.expoConfig?.extra || (Constants as any)?.manifest?.extra || {}) as Record<string, any>;
  const envKey = `ZB_${org}_ORG`;
  const legacy = extra?.[envKey] || (process.env as any)?.[envKey];
  if (!legacy) throw new Error(`Missing ORG for ${org}`);
  return String(legacy);
}







// ====================================================================
// Rate-limit helpers (shared): retry/backoff for Zoho 429/5xx + sleep
// ====================================================================
const ZB_RATE_DELAY_MS = 180;      // tiny pause between detail calls (safe for 400+ hydrations)
const ZB_MAX_RETRIES = 6;          // max retries for 429/5xx

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

/** Fetch JSON with retry/backoff for Zoho 429/5xx statuses. */
async function zFetchJSON(
  url: string,
  headers: Record<string, string>,
  label: string,
  log?: (s: string) => void
): Promise<any> {
  for (let attempt = 0; attempt <= ZB_MAX_RETRIES; attempt++) {
    const resp = await fetch(url, { headers });
    if (resp.ok) return await resp.json();

    const status = resp.status;
    const retryAfter = Number(resp.headers.get('Retry-After')) || 0;

    if (status === 429 || status === 502 || status === 503) {
      const wait = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(10000, 1000 * Math.pow(1.6, attempt + 1)); // backoff curve
      log?.(`${label} ${status} - retry ${attempt + 1}/${ZB_MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    const body = await resp.text();
    throw new Error(`${label} ${status} - ${body.slice(0, 140)}`);
  }
  throw new Error(`${label} - too many retries`);
}







// ---------------- Customers ----------------
// (Simple paged listing used by multiple screens)
export async function fetchCustomers(org: OrgKey) {
  const token = await getAccessToken(org);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  let page = 1;
  const out: any[] = [];
  while (true) {
    const url = `${BOOKS_BASE}/contacts?organization_id=${oid}&contact_type=customer&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Contacts ${r.status}`);
    const j = await r.json();
    out.push(...(j.contacts || []));
    if (!j.page_context?.has_more_page) break;
    page++;
  }
  return out.map((c) => ({ customer_id: c.contact_id, customer_name: c.contact_name })); // normalized shape
}







// ---------------- Invoices + Merge (existing) ----------------
// (Collect customer invoices in a date window, download PDFs, merge, and save)
export async function fetchInvoicesAndMerge(
  payload: { org: OrgKey; customer: string; from: string; to: string },
  log?: (s: string) => void
): Promise<{ fileUri: string; count: number; fileName: string }> {
  const { org, customer, from, to } = payload;
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  // 1) Collect invoices (paged)
  let page = 1;
  const matched: { invoice_id: string; invoice_number: string }[] = [];
  while (true) {
    const url = `${BOOKS_BASE}/invoices?organization_id=${oid}&date_start=${from}&date_end=${to}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Invoices ${r.status}`);
    const j = await r.json();
    for (const inv of j.invoices || []) {
      if ((inv.customer_name || '').trim().toLowerCase() === customer.trim().toLowerCase()) {
        matched.push({ invoice_id: inv.invoice_id, invoice_number: inv.invoice_number });
      }
    }
    if (!j.page_context?.has_more_page) break;
    page++;
  }
  if (matched.length === 0) throw new Error('No invoices found for selection');

  // 2) Download PDFs (as bytes)
  const pdfBuffers: Uint8Array[] = [];
  for (const inv of matched) {
    const pdfUrl = `${BOOKS_BASE}/invoices/${inv.invoice_id}?organization_id=${oid}&accept=pdf`;
    const r = await fetch(pdfUrl, { headers });
    if (!r.ok) continue;
    const bytes = new Uint8Array(await r.arrayBuffer());
    pdfBuffers.push(bytes);
    log?.(`...got #${inv.invoice_number} (${pdfBuffers.length}/${matched.length})`);
  }
  if (pdfBuffers.length === 0) throw new Error('No PDFs retrieved');

  // 3) Merge (in-memory)
  const mergedBytes = await mergePdfBytes(pdfBuffers);
  const base64 = fromByteArray(mergedBytes);
  const safeCustomer = customer.replace(/[\/\\]/g, '_').replace(/\s+/g, '_');
  const fileName = `${uniqueName()}_${org}_${safeCustomer}.pdf`;

  // 4) Save with legacy paths first (works reliably in Expo Go)
  const legacyDoc = FS.documentDirectory;
  const legacyCache = FS.cacheDirectory;
  log?.(`Legacy FS -> doc=${legacyDoc ?? 'null'} cache=${legacyCache ?? 'null'}`);

  const trySave = async (base: string | null | undefined) => {
    if (!base) return null;
    const dir = base + 'Anvaya/';
    await ensureDir(dir);
    const uri = dir + fileName;
    await FS.writeAsStringAsync(uri, base64, { encoding: FS.EncodingType.Base64 });
    return uri;
  };

  try {
    let uri = await trySave(legacyDoc);
    if (!uri) uri = await trySave(legacyCache);
    if (uri) {
      log?.(`Saved -> ${uri}`);
      return { fileUri: uri, count: pdfBuffers.length, fileName };
    }
  } catch (e: any) {
    log?.(`Legacy save failed: ${e?.message || e}`);
    // fall through to SAF
  }

  // 5) Android SAF fallback - user picks a folder
  if (Platform.OS === 'android' && (FS as any).StorageAccessFramework) {
    log?.('Requesting SAF folder permission...');
    const perm = await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (perm.granted) {
      log?.('SAF granted. Creating file...');
      const uri = await FS.StorageAccessFramework.createFileAsync(
        perm.directoryUri,
        fileName,
        'application/pdf'
      );
      await FS.writeAsStringAsync(uri, base64, { encoding: FS.EncodingType.Base64 });
      log?.(`Saved (SAF) -> ${uri}`);
      return { fileUri: uri, count: pdfBuffers.length, fileName };
    }
    throw new Error('SAF permission not granted by user');
  }

  throw new Error('No writable directory available');
}







// ---------------- Dispatch rows (PM/Dispatch screen) ----------------
// (Flat rows of invoices with LR/transport CFs for a single customer)
function readCF(inv: any, apiName: string) {
  const arr = inv?.custom_fields || inv?.customfield || [];
  const found = Array.isArray(arr)
    ? arr.find((cf: any) =>
        ((cf.api_name || cf.label || '') as string).toLowerCase() === apiName.toLowerCase()
      )
    : null;
  return found?.value ?? found?.show_value ?? inv?.[apiName] ?? '';
}

export async function fetchDispatchRows(
  payload: { org: OrgKey; customer: string; from: string; to: string },
  log?: (s: string) => void
): Promise<Array<{
  invoiceNo: string;
  invoiceDate: string;
  brand: string;
  amount: number;
  lrNo: string;
  lrDate: string;
  transport: string;
  type: string;
}>> {
  const { org, customer, from, to } = payload;
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  let page = 1;
  const out: any[] = [];
  while (true) {
    const url = `${BOOKS_BASE}/invoices?organization_id=${oid}&date_start=${from}&date_end=${to}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Invoices ${r.status}`);
    const j = await r.json();

    for (const inv of j.invoices || []) {
      if ((inv.customer_name || '').trim().toLowerCase() !== customer.trim().toLowerCase()) continue;

      out.push({
        invoiceNo: inv.invoice_number,
        invoiceDate: inv.date, // ISO yyyy-mm-dd
        brand: readCF(inv, 'cf_brand') || '',
        amount: Number(inv.total || inv.total_amount || inv.amount || 0),
        lrNo: readCF(inv, 'cf_lr_no') || '',
        lrDate: readCF(inv, 'cf_lr_date') || '',
        transport: readCF(inv, 'cf_transport_name') || '',
        type: readCF(inv, 'cf_type') || '',
      });
    }

    if (!j.page_context?.has_more_page) break;
    page++;
  }

  out.sort((a: any, b: any) =>
    a.invoiceDate > b.invoiceDate ? 1 : a.invoiceDate < b.invoiceDate ? -1 : 0
  );
  log?.(`Dispatch rows ready: ${out.length}`);
  return out;
}







// --- Add near other dispatch helpers ---
// (MTM item-wise grouping with CFs like size/packing/bale numbers)
export type ItemWiseGroupMTM = {
  invoiceNo: string;
  invoiceDate: string;   // ISO yyyy-mm-dd
  total: number;         // invoice total
  lrNo: string;
  lrDate: string;
  transport: string;
  items: Array<{
    itemName: string;    // cf_item_name
    size1: string;       // cf_size_1
    packing: string;     // cf_packing
    baleNo: string;      // cf_bale_no
    qty: number;
    rate: number;
  }>;
};

/** MTM only: fetch invoices in range for a customer and expand line items with CFs. */
export async function fetchDispatchItemWiseMTM(
  payload: { customer: string; from: string; to: string },
  log?: (s: string) => void
): Promise<ItemWiseGroupMTM[]> {
  const org: OrgKey = 'MTM';
  const { customer, from, to } = payload;
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  // helper for invoice-level CFs
  const readCFInv = (inv: any, key: string) => readCF(inv, key); // reuse existing readCF

  const out: ItemWiseGroupMTM[] = [];
  let page = 1;

  while (true) {
    const url = `${BOOKS_BASE}/invoices?organization_id=${oid}&date_start=${from}&date_end=${to}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Invoices ${r.status}`);
    const j = await r.json();

    for (const inv of j.invoices || []) {
      if ((inv.customer_name || '').trim().toLowerCase() !== customer.trim().toLowerCase()) continue;

      // Pull full invoice for line-level CFs
      const invId = String(inv.invoice_id || inv.invoiceId || inv.invoiceid);
      const rd = await fetch(`${BOOKS_BASE}/invoices/${invId}?organization_id=${oid}`, { headers });
      if (!rd.ok) continue;
      const detail = (await rd.json()).invoice || {};

      const items = [];
      for (const li of detail.line_items || []) {
        items.push({
          itemName: cfLine(li, 'cf_item_name', 'item name', 'item_name') || (li.name || ''),
          size1:    cfLine(li, 'cf_size_1', 'size 1', 'size1', 'size') || '',
          packing:  cfLine(li, 'cf_packing', 'packing', 'pack') || '',
          baleNo:   cfLine(li, 'cf_bale_no', 'bale', 'bale_no') || '',
          qty:      Number(li.quantity || 0),
          rate:     Number(li.rate ?? li.item_rate ?? 0),
        });
      }

      out.push({
        invoiceNo: inv.invoice_number,
        invoiceDate: inv.date,
        total: Number(inv.total || inv.total_amount || inv.amount || 0),
        lrNo: readCFInv(inv, 'cf_lr_no') || '',
        lrDate: readCFInv(inv, 'cf_lr_date') || '',
        transport: readCFInv(inv, 'cf_transport_name') || '',
        items,
      });
    }

    if (!j.page_context?.has_more_page) break;
    page++;
  }

  out.sort((a, b) => (a.invoiceDate > b.invoiceDate ? 1 : a.invoiceDate < b.invoiceDate ? -1 : 0));
  log?.(`Item-wise dispatch groups ready: ${out.length}`);
  return out;
}







// ---------------- Pending Dispatch (MTM) ----------------
// (Last 12 months SOs with pending quantities per line)
export function last12MonthsRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 12);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function cfLine(li: any, ...keys: string[]): string {
  for (const [k, v] of Object.entries(li || {})) {
    if (k.toLowerCase().startsWith('cf') && v) {
      if (keys.some((x) => k.toLowerCase().includes(x))) return String(v);
    }
  }
  for (const arrName of ['item_custom_fields', 'line_item_custom_fields', 'custom_fields']) {
    const arr = (li && (li as any)[arrName]) || [];
    for (const c of arr) {
      const label = String(c?.label || c?.api_name || '').toLowerCase();
      if (keys.some((x) => label.includes(x))) {
        return String(c?.value ?? c?.select_value ?? '');
      }
    }
  }
  return '';
}

export type PendingRow = {
  Customer: string;
  DateISO: string;
  DateStr: string;
  SO: string;
  Item: string;
  ItemCode: string;
  Packing: string;
  Rate: number;
  PendingQty: number;
  Amount: number;
};

export async function fetchPendingDispatchMTM(
  log?: (s: string) => void
): Promise<PendingRow[]> {
  const org: OrgKey = 'MTM';
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };
  const { start, end } = last12MonthsRange();

  log?.(`Last 12 months ${start}..${end} - listing Sales Orders...`);

  let page = 1;
  const soIds: string[] = [];
  while (true) {
    const url = `${BOOKS_BASE}/salesorders?organization_id=${oid}&status=confirmed&date_start=${start}&date_end=${end}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Salesorders ${r.status}`);
    const j = await r.json();
    (j.salesorders || []).forEach((s: any) => soIds.push(s.salesorder_id));
    if (!j.page_context?.has_more_page) break;
    page++;
  }

  log?.(`Found ${soIds.length} SOs - expanding lines...`);

  const out: PendingRow[] = [];
  for (const sid of soIds) {
    const url = `${BOOKS_BASE}/salesorders/${sid}?organization_id=${oid}`;
    const r = await fetch(url, { headers });
    if (!r.ok) continue;
    const so = (await r.json()).salesorder;

    const dtISO = so?.date || '';
    const d = dtISO ? new Date(dtISO) : null;
    const dateStr = d
      ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
      : '';

    for (const li of so?.line_items || []) {
      const qty = Number(li.quantity || 0);
      const invoiced = Number(li.quantity_invoiced || 0);
      const pending = qty - invoiced;
      if (pending <= 0) continue;

      const rate = Number(li.rate ?? li.item_rate ?? 0);
      out.push({
        Customer: so.customer_name || '',
        DateISO: dtISO,
        DateStr: dateStr,
        SO: so.salesorder_number || '',
        Item: li.name || '',
        ItemCode: cfLine(li, 'item code', 'item_name', 'item') || '',
        Packing: cfLine(li, 'packing', 'pack') || '',
        Rate: rate,
        PendingQty: pending,
        Amount: rate * pending,
      });
    }
  }

  log?.(`Pending rows collected: ${out.length}`);
  return out;
}







// === Boutique Images (MTM) ==========================================
// (Local cache of active MTM item images, with manifest + cleanup)
function boutiqueBaseDir(): string {
  const base = FS.documentDirectory || FS.cacheDirectory;
  if (!base) throw new Error('No writable directory available');
  return base + 'Anvaya/BoutiqueImages/';
}

// NOTE: do NOT redefine ensureDir here - we use the one from ./utils

async function readJSON(uri: string): Promise<any | null> {
  try {
    const info = await FS.getInfoAsync(uri);
    if (!info.exists) return null;
    const txt = await FS.readAsStringAsync(uri);
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
async function writeJSON(uri: string, obj: any) {
  await FS.writeAsStringAsync(uri, JSON.stringify(obj, null, 2));
}

type Manifest = {
  last_sync_time: string | null;
  items: {
    [itemId: string]: {
      item_name: string;
      item_modified_time?: string;
      docs: {
        [docId: string]: { file_name: string; size: number }
      }
    }
  }
};

async function loadManifest(): Promise<Manifest> {
  const base = boutiqueBaseDir();
  await ensureDir(base);
  const mf = await readJSON(base + '_manifest.json');
  return mf || { last_sync_time: null, items: {} };
}
async function saveManifest(mf: Manifest) {
  const base = boutiqueBaseDir();
  await ensureDir(base);
  await writeJSON(base + '_manifest.json', mf);
}

async function saveImage(folder: string, filename: string, data: Uint8Array) {
  const base = boutiqueBaseDir();
  const dir = base + folder + '/';
  await ensureDir(dir);
  const uri = dir + filename;
  const b64 = fromByteArray(data);
  await FS.writeAsStringAsync(uri, b64, { encoding: FS.EncodingType.Base64 });
  return uri;
}

export async function listBoutiqueFolders(): Promise<{ name: string; count: number }[]> {
  const base = boutiqueBaseDir();
  await ensureDir(base);
  const entries = await FS.readDirectoryAsync(base);
  const out: { name: string; count: number }[] = [];
  for (const name of entries) {
    if (name === '_manifest.json') continue;
    const info = await FS.getInfoAsync(base + name);
    if (!info.exists || !info.isDirectory) continue;
    const files = await FS.readDirectoryAsync(base + name + '/');
    out.push({ name, count: files.length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listImagesInFolder(prefix: string): Promise<string[]> {
  const base = boutiqueBaseDir();
  const dir = base + prefix + '/';
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) return [];
  const files = await FS.readDirectoryAsync(dir);
  return files.map((f) => dir + f);
}

/** Sync active MTM items with images and keep manifest tidy. */
export async function syncBoutiqueImagesMTM(log?: (s: string) => void): Promise<{ downloaded: number }> {
  const org: OrgKey = 'MTM';
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  const mf = await loadManifest();
  const activeSet = new Set<string>();
  let page = 1;
  let totalDownloaded = 0;

  while (true) {
    log?.(`Fetching ACTIVE items page ${page}...`);
    const url = `${BOOKS_BASE}/items?organization_id=${oid}&page=${page}&per_page=200&status=active`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Items ${r.status}`);
    const j = await r.json();
    const items = j.items || [];
    if (!items.length) break;

    for (const item of items) {
      if ((item.available_stock || 0) <= 0) continue;

      const itemId = String(item.item_id);
      const itemName = String(item.name || '');
      const prefix = (itemName.slice(0, 3) || 'UNK').toUpperCase();

      const detailUrl = `${BOOKS_BASE}/items/${itemId}?organization_id=${oid}`;
      const rd = await fetch(detailUrl, { headers });
      if (!rd.ok) continue;
      const detail = await rd.json();
      const it = detail.item || {};
      const docs = it.documents || [];
      const lastMod = it.last_modified_time;

      const mfItem = mf.items[itemId] || { item_name: itemName, item_modified_time: lastMod, docs: {} };
      const mfDocs = mfItem.docs || {};

      for (const doc of docs) {
        const docId = String(doc.document_id);
        const filename = doc.file_name || `${docId}.bin`;

        const rel = `${prefix}/${filename}`;
        activeSet.add(rel);

        const uri = boutiqueBaseDir() + rel;
        const known = mfDocs[docId];
        let skip = false;
        if (known && known.file_name === filename) {
          try {
            const info = await FS.getInfoAsync(uri);
            if (info.exists) {
              skip = true;
              log?.(`>>  Skip unchanged ${itemName} -> ${filename}`);
            }
          } catch {}
        }

        if (!skip) {
          const fileUrl = `${BOOKS_BASE}/documents/${docId}?organization_id=${oid}`;
          const rf = await fetch(fileUrl, { headers });
          if (rf.ok) {
            const bytes = new Uint8Array(await rf.arrayBuffer());
            await saveImage(prefix, filename, bytes);
            mfDocs[docId] = { file_name: filename, size: bytes.byteLength };
            totalDownloaded++;
            log?.(`OK Downloaded ${itemName} -> ${filename}`);
          } else {
            log?.(`ERR Failed download ${itemName} -> ${filename} (${rf.status})`);
          }
        }
      }

      mf.items[itemId] = {
        item_name: itemName,
        item_modified_time: lastMod,
        docs: mfDocs,
      };
    }

    if (!j.page_context?.has_more_page) break;
    page++;
  }

  // cleanup
  const base = boutiqueBaseDir();
  const folders = await FS.readDirectoryAsync(base);
  for (const folder of folders) {
    if (folder === '_manifest.json') continue;
    const dir = base + folder + '/';
    const info = await FS.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) continue;
    const files = await FS.readDirectoryAsync(dir);
    for (const f of files) {
      const rel = `${folder}/${f}`;
      if (!activeSet.has(rel)) {
        try {
          await FS.deleteAsync(dir + f);
          log?.(`DELETE Deleted ${rel}`);
        } catch {
          log?.(`WARN Could not delete ${rel}`);
        }
      }
    }
  }

  mf.last_sync_time = new Date().toISOString();
  await saveManifest(mf);

  return { downloaded: totalDownloaded };
}







/* ---------------- Outstanding (per customer) ---------------- */
// (Aging buckets by invoice bill date + CN + unused payments/advances)
const OPEN_STATUSES = ['draft', 'unpaid'] as const;
const TODAY = new Date();

const BUCKETS = [
  [0, 15, '0-15'],
  [16, 30, '16-30'],
  [31, 45, '31-45'],
  [46, 60, '46-60'],
  [61, 90, '61-90'],
  [91, 120, '91-120'],
  [121, 150, '121-150'],
  [151, 180, '151-180'],
  [181, 365, '181-365'],
  [366, 730, '366-730'],
  [731, 1e9, 'Above_730'],
] as const;

type BucketKey = (typeof BUCKETS)[number][2];

function safeNum(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function parseISO(d?: string): Date | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t) : null;
}
function daysBetween(a: Date, b: Date) {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 3600 * 1000));
}
function bucketIndex(days: number) {
  for (let i = 0; i < BUCKETS.length; i++) {
    const [lo, hi] = BUCKETS[i];
    if (lo <= days && days <= hi) return i;
  }
  return BUCKETS.length - 1;
}
function firstCity(contact: any): string {
  const bill = contact?.billing_address || {};
  const ship = contact?.shipping_address || {};
  const candidates = [bill.city, ship.city];
  for (const c of candidates) {
    if (String(c || '').trim()) return String(c).trim();
  }
  return '';
}
function getCF(contact: any, key: 'cf_division' | 'cf_agency'): string {
  const arr = contact?.custom_fields || [];
  for (const f of arr) {
    const lab = String(f?.label || '').toLowerCase();
    if (lab.includes(key)) return String(f?.value || f?.select_value || '');
  }
  return '';
}
function normalizeUnused(d: any): number {
  for (const k of ['unused_amount', 'unapplied_amount', 'unused_balance', 'balance']) {
    if (d?.[k] != null) return safeNum(d[k]);
  }
  const amt = safeNum(d?.amount ?? d?.total);
  const applied = safeNum(d?.applied_amount ?? d?.applied_amount_total);
  return Math.max(0, amt - applied);
}

export type OutstandingCustomerRow = {
  customerName: string;
  city: string;
  division?: string;
  agency?: string;
  // bucket keys
  '0-15': number; '16-30': number; '31-45': number; '46-60': number;
  '61-90': number; '91-120': number; '121-150': number; '151-180': number;
  '181-365': number; '366-730': number; 'Above_730': number;
  // summary
  Above_180: number;
  Total: number;
  CN: number;
  Payment: number;
  Balance: number;
  '0-15_payments': number;
  '16-90_payments': number;
};
export type OutstandingInvoiceRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  total: number;
  balance: number;
  age: number;
};


export async function fetchOutstandingForOrg(
  org: OrgKey,
  log?: (s: string) => void
): Promise<{ summary: Record<string, OutstandingCustomerRow>; invoices: Record<string, OutstandingInvoiceRow[]> }> {
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  // contacts
  log?.('Contacts...');
  const contacts: any[] = await paged(`${BOOKS_BASE}/contacts`, headers, { organization_id: oid });

  // open invoices
  const openInvoices: any[] = [];
  for (const st of OPEN_STATUSES) {
    log?.(`Invoices (${st})...`);
    const part = await paged(`${BOOKS_BASE}/invoices`, headers, { organization_id: oid, status: st });
    openInvoices.push(...part);
  }

  // open credit notes
  log?.('Credit notes (open)...');
  const creditnotes: any[] = await paged(`${BOOKS_BASE}/creditnotes`, headers, { organization_id: oid, status: 'open' });

  // payments (customerpayments)
  log?.('Payments...');
  const payments: any[] = await paged(`${BOOKS_BASE}/customerpayments`, headers, { organization_id: oid });

  // advances: customeradvancepayments OR retainerinvoices (fallback)
  let advances: any[] = [];
  try {
    log?.('Advance payments...');
    advances = await paged(`${BOOKS_BASE}/customeradvancepayments`, headers, { organization_id: oid });
  } catch {
    try {
      log?.('Retainer invoices (fallback)...');
      advances = await paged(`${BOOKS_BASE}/retainerinvoices`, headers, { organization_id: oid });
    } catch {
      advances = [];
    }
  }

  const invByC: Record<string, any[]> = {};
  for (const inv of openInvoices) {
    const cid = inv.customer_id || inv.contact_id;
    if (!cid) continue;
    (invByC[cid] = invByC[cid] || []).push(inv);
  }
  const cnByC: Record<string, number> = {};
  for (const cn of creditnotes) {
    const cid = cn.customer_id || cn.contact_id;
    if (!cid) continue;
    const rem = cn.remaining_credits ?? cn.balance;
    cnByC[cid] = (cnByC[cid] || 0) + safeNum(rem);
  }
  const payByC: Record<string, any[]> = {};
  for (const p of payments) {
    const cid = p.customer_id || p.contact_id;
    if (!cid) continue;
    (payByC[cid] = payByC[cid] || []).push(p);
  }
  const advByC: Record<string, any[]> = {};
  for (const a of advances) {
    const cid = a.customer_id || a.contact_id;
    if (!cid) continue;
    (advByC[cid] = advByC[cid] || []).push(a);
  }

  const rows: Record<string, OutstandingCustomerRow> = {};
  const invoicesByCustomer: Record<string, OutstandingInvoiceRow[]> = {};
  const groupMode: 'PM' | 'AGENCY' | 'NONE' =
    org === 'PM' ? 'PM' : org === 'MTM' || org === 'RMD' ? 'AGENCY' : 'NONE';

  const bucketKeys: BucketKey[] = BUCKETS.map((b) => b[2]);

  const idx_181 = bucketKeys.indexOf('181-365' as BucketKey);
  const idx_366 = bucketKeys.indexOf('366-730' as BucketKey);
  const idx_730 = bucketKeys.indexOf('Above_730' as BucketKey);

  for (const c of contacts) {
    const cid = c.contact_id;
    const custName = c.contact_name;
    const city = firstCity(c);

    const division = getCF(c, 'cf_division') || '(No Division)';
    const agency = getCF(c, 'cf_agency') || '(No Agency)';

    const invs = invByC[cid] || [];
    const pays = payByC[cid] || [];
    const advs = advByC[cid] || [];
    const cnSum = safeNum(cnByC[cid] || 0);

    // Unused = unused payments + unused advances
    const unusedPay = pays.reduce((s, p) => s + safeNum(p.unused_amount), 0);
    const unusedAdv = advs.reduce((s, a) => s + normalizeUnused(a), 0);
    const totalUnused = unusedPay + unusedAdv;

    // Payments windows (by payment date)
    let p0_15 = 0, p16_90 = 0;
    for (const p of pays) {
      const dt = parseISO(p.date);
      if (!dt) continue;
      const days = daysBetween(TODAY, dt);
      const amt = safeNum(p.amount);
      if (0 <= days && days <= 15) p0_15 += amt;
      else if (16 <= days && days <= 90) p16_90 += amt;
    }

    // Buckets by invoice BILL DATE
    const buckets = Array(BUCKETS.length).fill(0);
    const invoiceRows: OutstandingInvoiceRow[] = [];
    for (const inv of invs) {
      const dt = parseISO(inv.date);
      const totalAmount = safeNum(inv.total || inv.total_amount || inv.amount || 0);
      const rawBalance = safeNum(
        inv.balance ?? inv.balance_amount ?? inv.outstanding_balance ?? totalAmount
      );
      const age = dt ? Math.max(0, daysBetween(TODAY, dt)) : 0;
      if (rawBalance > 0 && dt) {
        buckets[bucketIndex(age)] += rawBalance;
      } else if (rawBalance > 0) {
        buckets[bucketIndex(0)] += rawBalance;
      }
      invoiceRows.push({
        invoiceId: String(inv.invoice_id || ''),
        invoiceNumber: String(inv.invoice_number || inv.invoice_id || ''),
        invoiceDate: String(inv.date || ''),
        total: round2(totalAmount),
        balance: round2(rawBalance),
        age,
      });
    }
    const unpaidInvoices = invoiceRows.filter((row) => row.balance > 0);
    invoicesByCustomer[custName] = unpaidInvoices.sort((a, b) =>
      a.invoiceDate.localeCompare(b.invoiceDate)
    );

    const totalOut = buckets.reduce((a, b) => a + b, 0);
    const above180 = round2(buckets[idx_181] + buckets[idx_366] + buckets[idx_730]);
    const balance = round2(totalOut - (cnSum + totalUnused));

    // prune all-zero
    if ((totalOut + cnSum + totalUnused + p0_15 + p16_90) === 0) continue;

    const row: OutstandingCustomerRow = {
      customerName: custName,
      city,
      ...(groupMode === 'PM' ? { division } : groupMode === 'AGENCY' ? { agency } : {}),
      '0-15': round2(buckets[bucketKeys.indexOf('0-15' as BucketKey)]),
      '16-30': round2(buckets[bucketKeys.indexOf('16-30' as BucketKey)]),
      '31-45': round2(buckets[bucketKeys.indexOf('31-45' as BucketKey)]),
      '46-60': round2(buckets[bucketKeys.indexOf('46-60' as BucketKey)]),
      '61-90': round2(buckets[bucketKeys.indexOf('61-90' as BucketKey)]),
      '91-120': round2(buckets[bucketKeys.indexOf('91-120' as BucketKey)]),
      '121-150': round2(buckets[bucketKeys.indexOf('121-150' as BucketKey)]),
      '151-180': round2(buckets[bucketKeys.indexOf('151-180' as BucketKey)]),
      '181-365': round2(buckets[bucketKeys.indexOf('181-365' as BucketKey)]),
      '366-730': round2(buckets[bucketKeys.indexOf('366-730' as BucketKey)]),
      'Above_730': round2(buckets[bucketKeys.indexOf('Above_730' as BucketKey)]),
      Above_180: above180,
      Total: round2(totalOut),
      CN: round2(cnSum),
      Payment: round2(totalUnused),
      Balance: balance,
      '0-15_payments': round2(p0_15),
      '16-90_payments': round2(p16_90),
    };

    rows[custName] = row;
  }

  return { summary: rows, invoices: invoicesByCustomer };
}

function round2(x: number) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

async function paged(baseUrl: string, headers: any, params: Record<string, any>): Promise<any[]> {
  let page = 1;
  const out: any[] = [];
  while (true) {
    const url = `${baseUrl}?${new URLSearchParams({ ...params, page: String(page), per_page: '200' }).toString()}`;
    const r = await fetch(url, { headers });
    if (r.status === 404) throw new Error('404');
    if (!r.ok) throw new Error(`${baseUrl} ${r.status}`);
    const j = await r.json();
    const key = Object.keys(j).find(k => Array.isArray((j as any)[k]));
    if (key) out.push(...(j as any)[key]);
    if (!j.page_context?.has_more_page) break;
    page++;
  }
  return out;
}







// --- MTM Sales Order helpers (non-breaking) ---
// (Customer with price list + flexible SO creator)
export async function fetchActiveCustomersWithPriceListMTM(
  log?: (s: string) => void
): Promise<Array<{ id: string; name: string; priceList: 'Exmill' | 'Nett' | '' }>> {
  const org = 'MTM';
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` } as const;

  let page = 1; const out: any[] = [];
  while (true) {
    const url = `${BOOKS_BASE}/contacts?organization_id=${oid}&contact_type=customer&status=active&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Contacts ${r.status}`);
    const j = await r.json();
    out.push(...(j.contacts || []));
    if (!j.page_context?.has_more_page) break;
    page++;
  }

  function readCF(contact: any, key: string): string {
    const arr = contact?.custom_fields || contact?.customfield || [];
    const found = Array.isArray(arr) ? arr.find((cf: any) => String(cf.api_name || cf.label || '').toLowerCase().includes(key.toLowerCase())) : null;
    const v = found?.value ?? found?.show_value ?? '';
    return String(v || '').trim();
  }

  return out.map((c) => {
    const raw = readCF(c, 'cf_price_list');
    const lc = raw.toLowerCase();
    const priceList: 'Exmill' | 'Nett' | '' = lc.includes('exmill') ? 'Exmill' : lc.includes('nett') ? 'Nett' : '';
    return { id: String(c.contact_id), name: String(c.contact_name || ''), priceList };
  });
}

/* ========= UPDATED: flexible SO creator ========= */
type SalesOrderLineById = {
  item_id: string;                 // Zoho Books item_id
  quantity: number;
  rate: number;
  tax_percentage?: number;
  item_custom_fields?: Array<{ api_name: string; value: any }>;
};

type SalesOrderLineByName = {
  name: string;                    // fallback if no item_id
  description?: string;
  quantity: number;
  rate: number;
  tax_percentage?: number;
  item_custom_fields?: Array<{ api_name: string; value: any }>;
};

export type NewSOInputMTM = {
  customer_id?: string;
  customer_name?: string;
  is_inclusive_tax?: boolean;
  line_items: Array<SalesOrderLineById | SalesOrderLineByName>;
};

function sanitizeItemId(raw: any): string {
  return String(raw ?? '').replace(/[^\d]/g, '');
}

export async function createSalesOrderMTM(input: NewSOInputMTM, log?: (s: string) => void): Promise<any> {
  const org: OrgKey = 'MTM';
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } as const;

  // Resolve customer_id if only name is provided (keeps legacy callers working)
  let customer_id = input.customer_id?.trim();
  if (!customer_id) {
    const name = (input.customer_name || '').trim();
    if (!name) throw new Error('customer_id or customer_name is required');
    const resp = await fetch(
      `${BOOKS_BASE}/contacts?organization_id=${oid}&contact_name=${encodeURIComponent(name)}`,
      { headers }
    );
    if (!resp.ok) throw new Error(`Customer lookup failed (${resp.status})`);
    const jj = await resp.json();
    const first = (jj.contacts || [])[0];
    if (!first?.contact_id) throw new Error(`Customer not found: ${name}`);
    customer_id = String(first.contact_id);
  }

  // Map lines: prefer item_id when present; otherwise fall back to item_name + description
  const line_items = (input.line_items || []).map((li: SalesOrderLineById | SalesOrderLineByName) => {
    const maybeId = (li as SalesOrderLineById).item_id as any;
    if (maybeId) {
      const cleanId = sanitizeItemId(maybeId);
      const out: any = {
        item_id: cleanId,
        quantity: Number((li as any).quantity) || 0,
        rate: Number((li as any).rate) || 0,
        tax_percentage: (li as any).tax_percentage ?? 5,
      };
      if ((li as any).item_custom_fields?.length) out.item_custom_fields = (li as any).item_custom_fields;
      return out;
    }
    // name/description fallback (legacy)
    const out: any = {
      item_name: (li as SalesOrderLineByName).name,
      description: (li as SalesOrderLineByName).description || '',
      quantity: Number((li as any).quantity) || 0,
      rate: Number((li as any).rate) || 0,
      tax_percentage: (li as any).tax_percentage ?? 5,
    };
    if ((li as any).item_custom_fields?.length) out.item_custom_fields = (li as any).item_custom_fields;
    return out;
  });

  // Books will reject if you send lines without either item_id or description
  const hasValid = line_items.some((l: any) => (l.item_id && l.quantity > 0) || (l.description && l.quantity > 0));
  if (!hasValid) throw new Error('No valid line items to create SO');

  const payload = {
    customer_id,
    is_inclusive_tax: Boolean(input.is_inclusive_tax),
    date: new Date().toISOString().slice(0, 10),
    line_items,
  };

  const r = await fetch(`${BOOKS_BASE}/salesorders?organization_id=${oid}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const txt = await r.text();
  if (!r.ok) throw new Error(`SO create failed ${r.status}: ${txt}`);

  const j = JSON.parse(txt);
  if (j.code && j.code !== 0) throw new Error(`SO create error ${j.code}: ${j.message || txt}`);

  return j.salesorder || j;
}



// -------- Item-wise generic types (shared by all firms) --------
// (Used by the multi-firm item-wise dispatch report)

export type ItemWiseGroup = {
  invoiceNo: string;
  invoiceDate: string;   // yyyy-mm-dd
  total: number;         // invoice total
  lrNo: string;
  lrDate: string;
  transport: string;
  items: Array<{
    itemName: string;        // li.name or cf_item_name
    size1?: string;          // MTM only
    packing?: string;        // MTM only
    baleNo?: string;         // MTM only
    designNo?: string;       // PM only (cf_design_no)
    description?: string;    // RMD/MURLI only (line item description)
    qty: number;
    rate: number;
  }>;
};






// -------- Generic item-wise fetcher for all orgs --------
// (Hydrates invoices and maps line CFs per org; sorts by date)

export async function fetchDispatchItemWise(
  org: OrgKey,
  payload: { customer: string; from: string; to: string },
  log?: (s: string) => void
): Promise<ItemWiseGroup[]> {
  const { customer, from, to } = payload;
  const token = await getAccessToken(org, log);
  const oid = orgId(org);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  const out: ItemWiseGroup[] = [];
  let page = 1;

  while (true) {
    const url = `${BOOKS_BASE}/invoices?organization_id=${oid}&date_start=${from}&date_end=${to}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Invoices ${r.status}`);
    const j = await r.json();

    for (const inv of j.invoices || []) {
      if ((inv.customer_name || '').trim().toLowerCase() !== customer.trim().toLowerCase()) continue;

      const invId = String(inv.invoice_id || inv.invoiceId || inv.invoiceid);
      const rd = await fetch(`${BOOKS_BASE}/invoices/${invId}?organization_id=${oid}`, { headers });
      if (!rd.ok) continue;
      const detail = (await rd.json()).invoice || {};
      const items: ItemWiseGroup['items'] = [];

      for (const li of detail.line_items || []) {
        // Common fields
        const baseName =
          cfLine(li, 'cf_item_name', 'item name', 'item_name') ||
          li.name ||
          '';
        const qty = Number(li.quantity || 0);
        const rate = Number(li.rate ?? li.item_rate ?? 0);

        // Initialize blank fields
        const row: ItemWiseGroup['items'][number] = {
          itemName: String(baseName || ''),
          qty, rate,
        };

        // Firm-wise mapping
        if (org === 'MTM') {
          row.size1   = cfLine(li, 'cf_size_1', 'size 1', 'size1', 'size') || '';
          row.packing = cfLine(li, 'cf_packing', 'packing', 'pack') || '';
          row.baleNo  = cfLine(li, 'cf_bale_no', 'bale', 'bale_no') || '';
        } else if (org === 'PM') {
          row.designNo = cfLine(li, 'cf_design_no', 'design no', 'design', 'design_no') || '';
        } else {
          // RMD / MURLI
          row.description = li.description || li.item_description || '';
        }

        items.push(row);
      }

      out.push({
        invoiceNo: inv.invoice_number,
        invoiceDate: inv.date,
        total: Number(inv.total || inv.total_amount || inv.amount || 0),
        lrNo: readCF(inv, 'cf_lr_no') || '',
        lrDate: readCF(inv, 'cf_lr_date') || '',
        transport: readCF(inv, 'cf_transport_name') || '',
        items,
      });
    }

    if (!j.page_context?.has_more_page) break;
    page++;
  }

  out.sort((a, b) => (a.invoiceDate > b.invoiceDate ? 1 : a.invoiceDate < b.invoiceDate ? -1 : 0));
  log?.(`Item-wise dispatch groups ready: ${out.length}`);
  return out;
}






// ---- Types ----
// (Data model for the Sale Order Status (MTM) screen)

export type SOStatusEvent = {
  invoice_id: string;
  invoice_number: string;
  date: string;   // YYYY-MM-DD
  qty: number;
  lrNo?: string;
  lrDate?: string;
  transport?: string;
};

export type SOStatusLine = {
  salesorder_item_id: string;
  item: string;   // cf_item_name fallback to line item name
  quantity: number;
  dispQty: number;
  events: SOStatusEvent[];
};

export type SOStatusSO = {
  salesorder_id: string;
  salesorder_number: string;
  date: string;   // YYYY-MM-DD
  customer_id: string;
  customer_name: string;
  lines: SOStatusLine[];
};






// ---------- helpers (scoped to MTM status) ----------
// (CF readers for invoice + line items)

function mtmGetCF(obj: any, keys: string[] | string): string | undefined {
  const arr: any[] = (obj?.custom_fields || obj?.item_custom_fields || []);
  const want = Array.isArray(keys) ? keys.map(k => k.toLowerCase()) : [String(keys).toLowerCase()];
  for (const cf of arr) {
    if (!cf) continue;
    const api = String(cf.api_name ?? cf.customfield_id ?? '').toLowerCase();
    const lab = String(cf.label ?? cf.customfield_label ?? '').toLowerCase();
    if (want.includes(api) || want.includes(lab)) {
      const v = cf.value ?? cf.show_value ?? cf.customfield_value;
      return v == null ? undefined : String(v);
    }
  }
  return undefined;
}

/** Convenience for line-item single key */
function mtmLineCF(li: any, key: string) {
  return mtmGetCF(li, [key]);
}

/** Minimal customer list for picker (MTM only) */
export async function listMTMCustomers(): Promise<{ id: string; name: string }[]> {
  const token = await getAccessToken('MTM');
  const oid = orgId('MTM');
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  const out: { id: string; name: string }[] = [];
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({
      organization_id: oid,
      page: String(page),
      per_page: '200',
      sort_column: 'contact_name',
      sort_order: 'A',
    });
    const r = await fetch(`${BOOKS_BASE}/contacts?${q.toString()}`, { headers });
    if (!r.ok) throw new Error(`Contacts ${r.status}`);
    const j = await r.json();
    out.push(...(j.contacts || []).map((c: any) => ({ id: c.contact_id, name: c.contact_name })));
    if (!j.page_context?.has_more_page) break;
    page++;
  }
  return out;
}






// ---------- core builder ----------
// (Build SO->invoice linkage for MTM within a date range)

export async function fetchSaleOrderStatusMTM(
  params: { from: string; to: string; customerId?: string },
  log?: (s: string) => void
): Promise<SOStatusSO[]> {
  const { from, to, customerId } = params;

  const token = await getAccessToken('MTM', log);
  const oid = orgId('MTM');
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  // 1) Sales Orders (list)
  const soList: any[] = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      organization_id: oid,
      date_start: from,
      date_end: to,
      page: String(page),
      per_page: '200',
    });
    if (customerId) q.append('customer_id', customerId);
    const r = await fetch(`${BOOKS_BASE}/salesorders?${q.toString()}`, { headers });
    if (!r.ok) throw new Error(`Sales Orders ${r.status}`);
    const j = await r.json();
    soList.push(...(j.salesorders || []));
    if (!j.page_context?.has_more_page) break;
  }
  if (soList.length === 0) return [];

  // 1b) Hydrate SOs (rate-limit safe)
const soFull: any[] = [];
for (const so of soList) {
  const url = `${BOOKS_BASE}/salesorders/${so.salesorder_id}?organization_id=${oid}`;
  const j = await zFetchJSON(url, headers as any, 'SO detail', log);
  soFull.push(j.salesorder);
  await sleep(ZB_RATE_DELAY_MS); // tiny pause to avoid 429
}

  // 2) Invoices (list)
  const invList: any[] = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      organization_id: oid,
      date_start: from,
      date_end: to,
      page: String(page),
      per_page: '200',
    });
    if (customerId) q.append('customer_id', customerId);
    const r = await fetch(`${BOOKS_BASE}/invoices?${q.toString()}`, { headers });
    if (!r.ok) throw new Error(`Invoices ${r.status}`);
    const j = await r.json();
    invList.push(...(j.invoices || []));
    if (!j.page_context?.has_more_page) break;
  }

 // 2b) Hydrate Invoices (rate-limit safe)
const invFull: any[] = [];
for (const inv of invList) {
  const url = `${BOOKS_BASE}/invoices/${inv.invoice_id}?organization_id=${oid}`;
  const j = await zFetchJSON(url, headers as any, 'Invoice detail', log);
  invFull.push(j.invoice);
  await sleep(ZB_RATE_DELAY_MS); // tiny pause to avoid 429
}

  const eventsBySOItem = new Map<string, SOStatusEvent[]>();
  for (const inv of invFull) {
    const lrNo = mtmGetCF(inv, ['cf_lr_no', 'LR No']);
    const lrDate = mtmGetCF(inv, ['cf_lr_date', 'LR Date']);
    const transport = mtmGetCF(inv, ['cf_transport_name', 'Transport Name', 'Transport']);

    for (const li of inv.line_items || []) {
      const soItemId =
        li.salesorder_item_id ||
        li.salesorder_line_item_id ||
        li.salesorderitem_id ||
        li.linked_salesorder_item_id;
      if (!soItemId) continue;

      const ev: SOStatusEvent = {
        invoice_id: inv.invoice_id,
        invoice_number: inv.invoice_number,
        date: inv.date,
        qty: Number(li.quantity ?? 0),
        lrNo: lrNo || undefined,
        lrDate: lrDate || undefined,
        transport: transport || undefined,
      };
      const arr = eventsBySOItem.get(String(soItemId)) || [];
      arr.push(ev);
      eventsBySOItem.set(String(soItemId), arr);
    }
  }

  // 4) Build per-SO model
  const out: SOStatusSO[] = [];
  for (const so of soFull) {
    const lines: SOStatusLine[] = [];

    for (const li of so.line_items || []) {
      const soItemId = li.line_item_id || li.salesorder_item_id || li.salesorderlineitem_id;
      const itemName =
        mtmLineCF(li, 'cf_item_name') ||
        mtmLineCF(li, 'cf_itemname') ||
        mtmLineCF(li, 'Item Name') ||
        li.name ||
        '';

      const evs = eventsBySOItem.get(String(soItemId)) || [];
      const dispQty = evs.reduce((s, e) => s + (e.qty || 0), 0);

      lines.push({
        salesorder_item_id: String(soItemId),
        item: String(itemName),
        quantity: Number(li.quantity || 0),
        dispQty: Number(dispQty || 0),
        events: evs.sort((a, b) => (a.date || '').localeCompare(b.date || '')),
      });
    }

    out.push({
      salesorder_id: so.salesorder_id,
      salesorder_number: so.salesorder_number,
      date: so.date,
      customer_id: so.customer_id,
      customer_name: so.customer_name,
      lines,
    });
  }

  log?.(`Sale Order Status (MTM): SOs=${out.length}`);
  return out;
} // end fetchSaleOrderStatusMTM






/** List active salespersons (MTM) -> {id, name}[] */
// (Used by SO Status filter; filters out inactive salespersons)

export async function fetchSalespersonsMTM(): Promise<{ id: string; name: string }[]> {
  const access = await getAccessToken('MTM');                  // <-- use your existing token helper
  const ORG = orgId('MTM');
  const url = `${BOOKS_BASE}/salespersons?organization_id=${ORG}&per_page=200`;

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${access}` },
  });
  if (!res.ok) throw new Error(`Salespersons HTTP ${res.status}`);
  const j = await res.json();

  const raw = Array.isArray(j.salespersons) ? j.salespersons : Array.isArray(j.data) ? j.data : [];
  const list = raw
    .filter((s: any) => s.is_active !== false)
    .map((s: any) => ({
      id: String(s.salesperson_id),
      name: s.name || s.salesperson_name || s.email || 'Unknown',
    }));
  return list;
}






/** Download Sales Order PDF to a local file (returns file path) */
// (Writes into cache/salesorders, returns absolute URI for viewer)

export async function downloadSalesOrderPdfMTM(salesorder_id: string): Promise<string> {
  const access = await getAccessToken('MTM');                  // <-- use your existing token helper
  const ORG = orgId('MTM');
  const url = `${BOOKS_BASE}/salesorders/${salesorder_id}?organization_id=${ORG}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${access}`,
      Accept: 'application/pdf',
    },
  });
  if (!res.ok) throw new Error(`SO PDF HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const dir = FS.cacheDirectory + 'salesorders/';
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}

  const file = `${dir}SO_${salesorder_id}.pdf`;
  const b64 = fromByteArray(new Uint8Array(buf));
  await FS.writeAsStringAsync(file, b64, { encoding: FS.EncodingType.Base64 });

  return file;
}





// inside your zoho.ts wrapper
async function getZoho(url: string, headers: any) {
  const r = await fetch(url, { headers })
  const text = await r.text()
  if (!r.ok) {
    let body: any = text
    try { body = JSON.parse(text) } catch {}
    const err: any = new Error(body?.message || `HTTP ${r.status}`)
    err.status = r.status; err.url = url; err.body = body
    throw err
  }
  return JSON.parse(text)
}