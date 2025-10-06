// src/lib/excel.ts
// Combines: Outstanding workbook builder + generic XLSX parser
// Uses legacy FS to avoid Expo SDK 54 deprecation warnings.

import * as FS from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import * as Sharing from 'expo-sharing';
import * as XLSXRaw from 'xlsx-js-style';
import type { CellObject, WorkBook, WorkSheet } from 'xlsx-js-style';
import { ensureDir, uniqueName } from './utils';
import { fetchOutstandingForOrg, type OutstandingCustomerRow } from './zoho';

// Make xlsx module work whether it exports default or not
type XLSXType = typeof XLSXRaw;
const XLSX = ((XLSXRaw as any)?.default ?? XLSXRaw) as XLSXType;

// ---- Types ----
export type OutstandingRow = OutstandingCustomerRow;       // for outstanding workbook
export type XlsxRow = Record<string, any>;                 // for generic XLSX parsing

// ---- Styling helpers ----
const BUCKET_HEADERS = [
  '0-15','16-30','31-45','46-60','61-90','91-120','121-150','151-180','181-365','366-730','Above_730',
] as const;

const AMOUNT_HEADERS = [
  ...BUCKET_HEADERS,
  'Above_180','Total','CN','Payment','Balance','0-15_payments','16-90_payments',
] as const;

const moneyFmt = '₹#,##,##0.00"/-";[Red]-₹#,##,##0.00"/-";"-"';

function bold(v: CellObject) {
  (v as any).s = { ...(v as any).s, font: { bold: true } };
  return v;
}
function withFill(v: CellObject, rgb: string) {
  (v as any).s = { ...(v as any).s, fill: { patternType: 'solid', fgColor: { rgb } } };
  return v;
}
function withBorder(v: CellObject, style: 'thin'|'medium'|'thick' = 'thin') {
  (v as any).s = { ...(v as any).s, border: {
    top: { style }, bottom: { style }, left: { style }, right: { style }
  }};
  return v;
}
function money(v: number): CellObject {
  const c: CellObject = { t: 'n', v };
  (c as any).s = { numFmt: moneyFmt };
  return c;
}
function text(v: string): CellObject { return { t: 's', v }; }

function headerRow(cols: string[]) {
  return cols.map(h => withBorder(withFill(bold(text(h)), 'D9E1F2'), 'thick'));
}
function subtotalRow(cols: string[], labelCol: number, label: string, sumCols: number[]) {
  const row: any[] = cols.map(() => withBorder(text('')));
  row[labelCol] = withFill(bold(text(label)), 'C6E0B4');
  for (const c of sumCols) row[c] = withFill(bold(money(0)), 'C6E0B4');
  return row;
}
function totalRow(cols: string[], labelCol: number, sumCols: number[]) {
  const row: any[] = cols.map(() => withBorder(text('')));
  row[labelCol] = withFill(bold(text('TOTAL')), '00CC00');
  for (const c of sumCols) row[c] = withFill(bold(money(0)), '00CC00');
  return row;
}
function pastelForBucket(h: string) {
  switch (h) {
    case '0-15': return 'E2EFDA';
    case '16-30': return 'FFF2CC';
    case '31-45': return 'D9E1F2';
    case '46-60': return 'EAE3F1';
    case '61-90': return 'FCE4D6';
    case '91-120': return 'EAE3F1';
    case '121-150': return 'E2EFDA';
    case '151-180': return 'FFF2CC';
    case '181-365':
    case '366-730':
    case 'Above_730':
    case 'Above_180': return 'D9E1F2';
    default: return undefined;
  }
}

// ---- Outstanding workbook ----
function sheetFromRows(
  title: string,
  rows: OutstandingRow[],
  mode: 'PM' | 'AGENCY' | 'NONE'
): WorkSheet {
  const leftCols = mode === 'PM'
    ? ['Division','Customer Name','City']
    : mode === 'AGENCY'
      ? ['Agency','Customer Name','City']
      : ['Customer Name','City'];

  const cols = [...leftCols, ...AMOUNT_HEADERS];

  const aoa: any[][] = [];
  aoa.push(headerRow(cols));

  const groupKey = mode === 'PM' ? 'division' : mode === 'AGENCY' ? 'agency' : null;
  const groups: Record<string, OutstandingRow[]> = {};

  if (groupKey) {
    for (const r of rows) {
      const g = (r as any)[groupKey] || (mode === 'PM' ? '(No Division)' : '(No Agency)');
      (groups[g] = groups[g] || []).push(r);
    }
  } else {
    groups['__ALL__'] = rows.slice();
  }

  const amountIdx = cols.map((_, i) => i).filter(i => AMOUNT_HEADERS.includes(cols[i] as any));
  const labelCol = leftCols.length > 2 ? 1 : 0;

  let grandTotals = new Array(cols.length).fill(0);

  const pushRow = (r: any[]) => {
    aoa.push(r);
    amountIdx.forEach(ci => {
      const cell = r[ci];
      const val = cell && typeof cell.v === 'number' ? cell.v : 0;
      grandTotals[ci] += val;
    });
  };

  const groupsOrdered = Object.keys(groups).sort((a,b) => a.localeCompare(b));
  for (const g of groupsOrdered) {
    const list = groups[g].slice().sort((a,b) => a.customerName.localeCompare(b.customerName));

    for (const r of list) {
      const base: any[] = cols.map(() => withBorder(text('')));
      let ci = 0;
      if (mode === 'PM') { base[ci++] = withBorder(text(r.division || '(No Division)')); }
      if (mode === 'AGENCY') { base[ci++] = withBorder(text(r.agency || '(No Agency)')); }
      base[ci++] = withBorder(text(r.customerName));
      base[ci++] = withBorder(text(r.city || ''));

      const put = (h: typeof AMOUNT_HEADERS[number], v: number) => {
        const idx = cols.indexOf(h);
        base[idx] = withBorder(money(v || 0));
        const fill = pastelForBucket(h);
        if (fill) base[idx] = withFill(base[idx], fill);
      };

      put('0-15', r['0-15']); put('16-30', r['16-30']); put('31-45', r['31-45']); put('46-60', r['46-60']);
      put('61-90', r['61-90']); put('91-120', r['91-120']); put('121-150', r['121-150']); put('151-180', r['151-180']);
      put('181-365', r['181-365']); put('366-730', r['366-730']); put('Above_730', r['Above_730']);
      put('Above_180', r['Above_180']); put('Total', r.Total);
      put('CN', r.CN); put('Payment', r.Payment); put('Balance', r.Balance);
      put('0-15_payments', r['0-15_payments']); put('16-90_payments', r['16-90_payments']);

      pushRow(base);
    }

    const sub = subtotalRow(
      cols,
      labelCol,
      mode === 'NONE' ? 'Subtotal' : `${mode === 'PM' ? 'Division' : 'Agency'} Subtotal`,
      amountIdx
    );

    const startIdx = aoa.length - list.length;
    const endIdx = aoa.length - 1;
    for (const ci of amountIdx) {
      let s = 0;
      for (let ri = startIdx; ri <= endIdx; ri++) {
        const v = aoa[ri][ci]?.v;
        if (typeof v === 'number') s += v;
      }
      (sub[ci] = sub[ci] || money(0)).v = s;
    }
    aoa.push(sub);
  }

  const total = totalRow(cols, labelCol, amountIdx);
  for (const ci of amountIdx) (total[ci] = total[ci] || money(0)).v = grandTotals[ci];
  aoa.push(total);

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // column widths
  const colWidths = cols.map(h => {
    const base = h.length + 2;
    if (AMOUNT_HEADERS.includes(h as any)) return { wch: Math.max(12, base) };
    return { wch: Math.max(14, base) };
  });
  (ws as any)['!cols'] = colWidths;

  // hide longer buckets; keep Above_180 visible
  const hideKeys = new Set(['181-365','366-730','Above_730']);
  (ws as any)['!cols'] = (ws as any)['!cols'].map((c: any, i: number) =>
    hideKeys.has(cols[i]) ? { ...(c||{}), hidden: true } : c
  );

  // pastel fills for bucket columns
  cols.forEach((h, ci) => {
    const fill = pastelForBucket(h);
    if (!fill) return;
    const range = XLSX.utils.decode_range(ws['!ref'] as string);
    for (let r = 1; r <= range.e.r; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c: ci });
      const cell = ws[cellRef]; if (!cell) continue;
      (cell as any).s = { ...(cell as any).s, fill: { patternType: 'solid', fgColor: { rgb: fill } } };
    }
  });

  return ws;
}

async function saveAndShare(workbook: WorkBook, filename: string) {
  const wbout = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
  const dir = FS.documentDirectory || FS.cacheDirectory;
  if (!dir) throw new Error('No writable directory available');
  const outDir = dir + 'Anvaya/';
  await ensureDir(outDir);
  const uri = outDir + filename;
  await FS.writeAsStringAsync(uri, wbout, { encoding: FS.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
  return uri;
}

/** Build the 4-sheet Outstanding workbook (PM/MTM/RMD/Murli) */
export async function buildAndShareOutstandingWorkbook(log?: (s: string) => void) {
  const sheets: { name: string; ws: WorkSheet }[] = [];

  log?.('PM…');
  const pm = await fetchOutstandingForOrg('PM', log);
  sheets.push({ name: 'PM Outstanding', ws: sheetFromRows('PM Outstanding', Object.values(pm), 'PM') });

  log?.('MTM…');
  const mtm = await fetchOutstandingForOrg('MTM', log);
  sheets.push({ name: 'MTM Outstanding', ws: sheetFromRows('MTM Outstanding', Object.values(mtm), 'AGENCY') });

  log?.('RMD…');
  const rmd = await fetchOutstandingForOrg('RMD', log);
  sheets.push({ name: 'RMD Outstanding', ws: sheetFromRows('RMD Outstanding', Object.values(rmd), 'AGENCY') });

  log?.('Murli…');
  const muli = await fetchOutstandingForOrg('MURLI', log);
  sheets.push({ name: 'Murli Outstanding', ws: sheetFromRows('Murli Outstanding', Object.values(muli), 'NONE') });

  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, s.ws, s.name);

  const file = `Outstanding_${uniqueName()}.xlsx`;
  const uri = await saveAndShare(wb, file);
  return { uri, file };
}

// ---- Generic XLSX parser (used by Pricebook) ----
/**
 * Parse an XLSX file (local path or http/https URL) and return rows from the FIRST sheet.
 * - If a URL is provided, it's downloaded to cache first.
 * - Empty cells become '' (not undefined).
 */
export async function parseXlsx(uri: string): Promise<XlsxRow[]> {
  if (!uri) throw new Error('parseXlsx: uri is empty');

  let fileUri = uri;

  // Download if it's a remote URL
  if (/^https?:\/\//i.test(uri)) {
    const key = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, uri);
    fileUri = `${FS.cacheDirectory}${key}.xlsx`;
    const { status } = await FS.downloadAsync(uri, fileUri);
    if (status < 200 || status >= 400) {
      throw new Error(`XLSX download failed: HTTP ${status}`);
    }
  }

  // Read & parse
  const b64 = await FS.readAsStringAsync(fileUri, { encoding: FS.EncodingType.Base64 });
  const wb = XLSX.read(b64, { type: 'base64' });
  const first = wb.SheetNames[0];
  if (!first) return [];
  const ws = wb.Sheets[first];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// Default export for flexibility
export default { parseXlsx, buildAndShareOutstandingWorkbook };
