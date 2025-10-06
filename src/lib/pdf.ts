// src/lib/pdf.ts
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type { ItemWiseGroupMTM, OutstandingInvoiceRow } from './zoho';

/**
 * Replace characters not supported by WinAnsi (Helvetica) with ASCII fallbacks.
 * - right arrow becomes ->
 * - left arrow becomes <-
 * - en/em dashes become -
 * - ellipsis becomes ...
 * - any other non-ASCII character is stripped
 */
const RIGHT_ARROW = String.fromCharCode(0x2192);
const LEFT_ARROW = String.fromCharCode(0x2190);
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const ELLIPSIS = String.fromCharCode(0x2026);
const HARD_HYPHEN = String.fromCharCode(0x2011);

function safeText(input: string): string {
  if (!input) return '';
  return input
    .replace(new RegExp(RIGHT_ARROW, 'g'), '->')
    .replace(new RegExp(LEFT_ARROW, 'g'), '<-')
    .replace(new RegExp(`${EN_DASH}|${EM_DASH}`, 'g'), '-')
    .replace(new RegExp(ELLIPSIS, 'g'), '...')
    .replace(new RegExp(HARD_HYPHEN, 'g'), '-')
    .replace(/[^\x00-\x7F]/g, '');
}

/**
 * Merge multiple PDF byte arrays (Uint8Array) into a single PDF.
 */
export async function mergePdfBytes(buffers: Uint8Array[]): Promise<Uint8Array> {
  if (!buffers.length) throw new Error('mergePdfBytes: no inputs');
  const merged = await PDFDocument.create();

  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  return merged.save(); // Uint8Array
}

/**
 * Create a clean, phone-friendly Dispatch PDF table.
 * Columns (dynamic): Invoice No, Date, Brand, Amount, LR No, [LR Date], [Transport]
 */
export async function generateDispatchPdf(opts: {
  heading: string;
  rows: Array<{
    invoiceNo: string;
    invoiceDate: string;
    brand: string;
    amount: number;
    lrNo: string;
    lrDate: string;
    transport: string;
    type?: string;
  }>;
  showLRDate: boolean;
  showTransport: boolean;
  groupByType?: boolean;
}): Promise<Uint8Array> {
  const { heading, rows, showLRDate, showTransport, groupByType = false } = opts;

  // A4 (portrait)
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 36;

  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  const columns = [
    { key: 'invoiceNo', label: 'Invoice No.', width: 90 },
    { key: 'invoiceDate', label: 'Date', width: 65 },
    { key: 'brand', label: 'Brand', width: 110 },
    { key: 'amount', label: 'Amount', width: 70 },
    { key: 'lrNo', label: 'LR No.', width: 90 },
    ...(showLRDate ? [{ key: 'lrDate', label: 'LR Date', width: 70 }] : []),
    ...(showTransport ? [{ key: 'transport', label: 'Transport', width: 120 }] : []),
  ] as { key: keyof (typeof rows)[number]; label: string; width: number }[];

  const titleSize = 16;
  const subSize = 10;
  const headerSize = 11;
  const cellSize = 10;
  const rowHeight = 18;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  page.drawText('Dispatch Details', {
    x: margin,
    y: y - titleSize,
    size: titleSize,
    font: fontBold,
  });
  y -= titleSize + 6;

  const safeHeading = safeText(heading);
  page.drawText(safeHeading, {
    x: margin,
    y: y - subSize,
    size: subSize,
    font: fontReg,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= subSize + 10;

  const drawHeader = () => {
    let x = margin;
    columns.forEach((c) => {
      page.drawText(c.label, { x, y: y - headerSize, size: headerSize, font: fontBold });
      x += c.width;
    });
    y -= headerSize + 4;
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageWidth - margin, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 6;
  };

  const drawGroupLabel = (label: string) => {
    if (y < margin + headerSize * 3) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      drawHeader();
    }
    page.drawText(`Type: ${label}`, {
      x: margin,
      y: y - headerSize,
      size: headerSize,
      font: fontBold,
      color: rgb(0.25, 0.25, 0.25),
    });
    y -= headerSize + 6;
  };

  const drawRow = (row: (typeof rows)[number]) => {
    let x = margin;
    columns.forEach((c) => {
      let text = row[c.key] ?? '';
      if (typeof text === 'number') text = text.toFixed(2);
      else text = String(text);
      const maxChars = Math.max(3, Math.floor(c.width / (cellSize * 0.55)));
      if (text.length > maxChars) {
        text = text.slice(0, maxChars - 3) + '...';
      }
      text = safeText(text);
      page.drawText(text, { x, y: y - cellSize, size: cellSize, font: fontReg });
      x += c.width;
    });
    y -= rowHeight;
  };

  const orderedRows = groupByType
    ? [...rows].sort((a, b) => {
        const at = safeText((a.type || '').trim());
        const bt = safeText((b.type || '').trim());
        const cmp = at.localeCompare(bt);
        if (cmp !== 0) return cmp;
        return (a.invoiceDate || '').localeCompare(b.invoiceDate || '');
      })
    : rows;

  drawHeader();

  let currentType: string | null = null;
  for (const r of orderedRows) {
    if (groupByType) {
      const nextType = safeText((r.type || '').trim() || 'No Type');
      if (currentType !== nextType) {
        currentType = nextType;
        drawGroupLabel(nextType);
      }
    }
    if (y < margin + 40) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      drawHeader();
      if (groupByType && currentType) {
        drawGroupLabel(currentType);
      }
    }
    drawRow(r);
  }

  const total = orderedRows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  if (y < margin + 40) {
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  }
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 14;
  page.drawText(`Total Invoices: ${orderedRows.length}` , {
    x: margin,
    y: y - cellSize,
    size: cellSize,
    font: fontBold,
  });
  page.drawText(`Total Amount: ${total.toFixed(2)}`, {
    x: margin + 180,
    y: y - cellSize,
    size: cellSize,
    font: fontBold,
  });

  return await doc.save();
}



/* ---------------- Outstanding (label/value card) ------------------------ */
export async function generateOutstandingCardPdf(opts: {
  title: string;
  org: string;
  customer: string;
  rows: { label: string; value: string }[];
}): Promise<Uint8Array> {
  const { title, org, customer, rows } = opts;

  // A4 portrait
  const pageWidth = 595.28;
  const pageHeight = 841.89;

  // Tighter margins so content fills the page more
  const marginX = 20;
  const marginY = 24;

  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  // Larger type so you don't need to zoom
  const titleSize = 22;
  const subSize = 12;
  const rowSize = 14;
  const rowH = 28;

  const labelColWidth = 260; // wider labels
  const tableLeft = marginX;
  const tableRight = pageWidth - marginX;

  const drawHeader = (page: PDFPage) => {
    let y = page.getSize().height - marginY;

    // Title
    page.drawText(safeText(title), {
      x: marginX,
      y: y - titleSize,
      size: titleSize,
      font: fontBold,
    });
    y -= titleSize + 6;

    // Sub-title (org - customer)
    const sub = `${org} - ${customer}`;
    page.drawText(safeText(sub), {
      x: marginX,
      y: y - subSize,
      size: subSize,
      font: fontReg,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= subSize + 10;

    // Divider
    page.drawLine({
      start: { x: tableLeft, y },
      end: { x: tableRight, y },
      thickness: 1.2,
      color: rgb(0.25, 0.25, 0.25),
    });
    y -= 10;

    return y;
  };

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = drawHeader(page);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    // New page if needed (leave room for 1 row)
    if (y < marginY + rowH) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = drawHeader(page);
    }

    // Optional subtle row banding to boost legibility
    if (i % 2 === 0) {
      page.drawRectangle({
        x: tableLeft,
        y: y - rowH + 6,
        width: tableRight - tableLeft,
        height: rowH - 6,
        color: rgb(0.96, 0.96, 0.98),
      });
    }

    // Label (left)
    page.drawText(safeText(r.label), {
      x: tableLeft,
      y: y - rowSize,
      size: rowSize,
      font: fontBold,
      color: rgb(0.05, 0.05, 0.05),
    });

    // Value (right-aligned in the remaining space)
    const valueXRight = tableRight; // right edge
    const valueText = safeText(r.value);
    const valueWidth = fontReg.widthOfTextAtSize(valueText, rowSize);
    const valueX = Math.max(tableLeft + labelColWidth + 12, valueXRight - valueWidth);

    page.drawText(valueText, {
      x: valueX,
      y: y - rowSize,
      size: rowSize,
      font: fontReg,
      color: rgb(0.05, 0.05, 0.05),
    });

    y -= rowH;
  }

  return await doc.save();
}


export async function generateOutstandingInvoicePdf(opts: {
  org: string;
  customer: string;
  invoices: OutstandingInvoiceRow[];
}): Promise<Uint8Array> {
  const { org, customer, invoices } = opts;

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 32;

  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  const columns: Array<{ key: keyof OutstandingInvoiceRow; label: string; width: number; align?: 'left' | 'right'; }> = [
    { key: 'invoiceDate', label: 'Date', width: 90 },
    { key: 'invoiceNumber', label: 'Invoice #', width: 120 },
    { key: 'total', label: 'Total', width: 100, align: 'right' },
    { key: 'balance', label: 'Balance', width: 100, align: 'right' },
    { key: 'age', label: 'Age (days)', width: 90, align: 'right' },
  ];

  const titleSize = 18;
  const subSize = 11;
  const headerSize = 11;
  const cellSize = 10;
  const rowHeight = 18;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  page.drawText('Outstanding Invoices', {
    x: margin,
    y: y - titleSize,
    size: titleSize,
    font: fontBold,
  });
  y -= titleSize + 6;

  const subtitle = `${safeText(org)} - ${safeText(customer)}`;
  page.drawText(subtitle, {
    x: margin,
    y: y - subSize,
    size: subSize,
    font: fontReg,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= subSize + 10;

  const drawHeader = () => {
    let x = margin;
    columns.forEach((c) => {
      page.drawText(c.label, { x, y: y - headerSize, size: headerSize, font: fontBold });
      x += c.width;
    });
    y -= headerSize + 4;
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageWidth - margin, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 6;
  };

  const formatAmount = (value: number) => {
    try {
      return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    } catch {
      return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
    }
  };

  const drawRow = (row: OutstandingInvoiceRow) => {
    let x = margin;
    for (const col of columns) {
      let text: string;
      if (col.key === 'total' || col.key === 'balance') {
        text = formatAmount(Number(row[col.key] || 0));
      } else if (col.key === 'age') {
        text = String(Math.max(0, Number(row.age || 0)));
      } else {
        text = safeText(String(row[col.key] ?? ''));
      }
      const maxChars = Math.max(3, Math.floor(col.width / (cellSize * 0.55)));
      if (text.length > maxChars) {
        text = text.slice(0, maxChars - 3) + '...';
      }
      const drawX = col.align === 'right'
        ? x + col.width - fontReg.widthOfTextAtSize(text, cellSize)
        : x;
      page.drawText(text, { x: drawX, y: y - cellSize, size: cellSize, font: fontReg });
      x += col.width;
    }
    y -= rowHeight;
  };

  const ordered = [...invoices].sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || ''));

  drawHeader();

  for (const inv of ordered) {
    if (y < margin + 40) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      drawHeader();
    }
    drawRow(inv);
  }

  const buckets = new Map<number, number>();
  let totalBalance = 0;
  for (const inv of ordered) {
    const bal = Number(inv.balance || 0);
    if (bal <= 0) continue;
    totalBalance += bal;
    const age = Math.max(0, Math.floor(Number(inv.age || 0)));
    let bucket = Math.floor(age / 15);
    if (age > 0 && age % 15 === 0) bucket = Math.max(0, bucket - 1);
    buckets.set(bucket, (buckets.get(bucket) || 0) + bal);
  }

  if (y < margin + 80) {
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  }

  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 12;

  const bucketEntries = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
  for (const [idx, amt] of bucketEntries) {
    if (amt <= 0) continue;
    const rangeStart = idx === 0 ? 0 : idx * 15 + 1;
    const rangeEnd = (idx + 1) * 15;
    const label = idx === 0 ? '0-15 days' : `${rangeStart}-${rangeEnd} days`;
    const amountText = formatAmount(amt);
    page.drawText(safeText(label), { x: margin, y: y - cellSize, size: cellSize, font: fontBold });
    const amountWidth = fontReg.widthOfTextAtSize(amountText, cellSize);
    page.drawText(amountText, {
      x: pageWidth - margin - amountWidth,
      y: y - cellSize,
      size: cellSize,
      font: fontReg,
    });
    y -= rowHeight;
    if (y < margin + 40) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  }

  const totalText = `Total Outstanding: ${formatAmount(totalBalance)}`;
  page.drawText(totalText, {
    x: margin,
    y: y - cellSize,
    size: cellSize,
    font: fontBold,
  });

  return await doc.save();
}




// --- DROP-IN: replaces generateDispatchItemWisePdfMTM in src/lib/pdf.ts ---
// Keep your existing imports (PDFDocument, StandardFonts, rgb) and ItemWiseGroupMTM type.

export async function generateDispatchItemWisePdfMTM(opts: {
  heading: string;                 // we print this once under the title
  groups: ItemWiseGroupMTM[];      // invoice groups with items
  showLRDetails: boolean;          // SINGLE checkbox controls LR No + LR Date + Transport
}): Promise<Uint8Array> {
  const { heading, groups, showLRDetails } = opts;

  const doc = await PDFDocument.create();
  const pageWidth = 595.28, pageHeight = 841.89, margin = 36;
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg  = await doc.embedFont(StandardFonts.Helvetica);

  // Compact mobile-friendly sizes
  const titleSize = 15, subSize = 9.5, thSize = 9.5, tdSize = 9.5;
  const rowH = 14;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  // Helpers -------------------------------------------------------
  const widthOf = (f: any, sz: number, s: string) => f.widthOfTextAtSize(s, sz);
  const needPage = (need: number) => {
    if (y - need < margin) { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
  };

  const safe = (s: any) => (s ?? '').toString().replace(/\s+/g, ' ').trim();
  const ansi = (s: string) =>
    safe(s)
      .replace(/\u2192/g, '->')
      .replace(/[\u2013\u2014]/g, '-');

  // dd/mm/yy from 'yyyy-mm-dd' (or ISO with time)
  const dmy = (iso: string) => {
    const m = safe(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return safe(iso);
    return `${m[3]}/${m[2]}/${m[1].slice(-2)}`;
  };

  // Indian integer (no decimals)
  const inrInt = (n: number) => {
    const v = Math.round(n || 0);
    const s = Math.abs(v).toString();
    if (s.length <= 3) return (v < 0 ? '-' : '') + s;
    const head = s.slice(0, s.length - 3);
    const tail = s.slice(-3);
    const headGrouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + headGrouped + ',' + tail;
  };

  // Draw text left/right aligned inside a column box
  const drawCell = (txt: string, x: number, w: number, align: 'L'|'R', sz: number, font: any) => {
    txt = ansi(txt);
    const maxChars = Math.max(3, Math.floor(w / (sz * 0.54)));
    if (txt.length > maxChars) txt = txt.slice(0, maxChars - 1) + '...';
    const tw = widthOf(font, sz, txt);
    const tx = align === 'R' ? (x + w - tw) : x;
    page.drawText(txt, { x: tx, y: y - sz, size: sz, font });
  };

  // Layout --------------------------------------------------------
  // Title
  page.drawText('Dispatch Item-wise (MTM)', { x: margin, y: y - titleSize, size: titleSize, font: fontBold });
  y -= titleSize + 5;

  // Subtitle (customer + range)
  page.drawText(ansi(heading), { x: margin, y: y - subSize, size: subSize, font: fontReg, color: rgb(0.2,0.2,0.2) });
  y -= subSize + 8;

  // Define one-time table header (DOES NOT REPEAT)
  // Shrunk Item column to keep row in a single line.
  const cols = [
    { k: 'inv',   label: 'Inv',   w: 70, align: 'L' as const },
    { k: 'date',  label: 'Date',  w: 50, align: 'L' as const },
    { k: 'item',  label: 'Item',  w: 90, align: 'L' as const },  // smaller
    { k: 'size',  label: 'Size',  w: 55, align: 'L' as const },
    { k: 'pack',  label: 'Pack',  w: 55, align: 'L' as const },
    { k: 'bale',  label: 'Bale',  w: 45, align: 'L' as const },
    { k: 'qty',   label: 'Qty',   w: 36, align: 'R' as const },
    { k: 'rate',  label: 'Rate',  w: 42, align: 'R' as const },
    { k: 'total', label: 'Total', w: 60, align: 'R' as const },
  ];
  const x0 = margin;
  const tableW = cols.reduce((a, c) => a + c.w, 0);

  // Header once
  needPage(thSize + 4);
  let x = x0;
  for (const c of cols) {
    page.drawText(c.label, { x, y: y - thSize, size: thSize, font: fontBold });
    x += c.w;
  }
  y -= thSize + 3;
  page.drawLine({ start: { x: x0, y }, end: { x: x0 + tableW, y }, thickness: 0.5, color: rgb(0.8,0.8,0.8) });
  y -= 3;

  // Rows per invoice group
  for (const g of groups) {
    const invNo = ansi(g.invoiceNo);
    const invDate = dmy(g.invoiceDate);
    const invTotal = inrInt(Number(g.total || 0));

    // line-items
    for (let i = 0; i < g.items.length; i++) {
      const it = g.items[i];
      const cells = {
        inv: invNo,
        date: invDate,
        item: safe(it.itemName),
        size: safe(it.size1),
        pack: safe(it.packing),
        bale: safe(it.baleNo),
        qty: String(Math.round(Number(it.qty || 0))),
        rate: Number(it.rate ?? 0).toFixed(2),      // keep 2dp for Rate
        total: i === 0 ? invTotal : '',            // only once per invoice
      };

      // row
      needPage(tdSize + 4);
      x = x0;
      for (const c of cols) {
        drawCell((cells as any)[c.k] ?? '', x, c.w, c.align, tdSize, fontReg);
        x += c.w;
      }
      y -= rowH;
    }

    // Optional LR details line after the invoice block (spanning full width)
    if (showLRDetails) {
      const lr = safe(g.lrNo) || '-';
      const lrdt = g.lrDate ? dmy(g.lrDate) : '-';
      const tr = safe(g.transport) || '-';
      const line = `LR No - ${ansi(lr)}   LR Dt - ${ansi(lrdt)}   Transport - ${ansi(tr)}`;

      needPage(tdSize + 3);
      page.drawText(line, { x: x0, y: y - tdSize, size: tdSize, font: fontReg, color: rgb(0.2,0.2,0.2) });
      y -= rowH - 2;
    }
  }

  return doc.save();
}


// -------- Generic item-wise PDF for all orgs (header once, per your spec) --------
import type { ItemWiseGroup } from './zoho';
import type { OrgKey } from './zoho';

export async function generateDispatchItemWisePdf(opts: {
  heading: string;                 // printed once under title
  groups: ItemWiseGroup[];
  org: OrgKey;                     // 'PM' | 'MTM' | 'RMD' | 'MURLI'
  showLRDetails: boolean;          // single checkbox
}): Promise<Uint8Array> {
  const { heading, groups, org, showLRDetails } = opts;

  const doc = await PDFDocument.create();
  const pageWidth = 595.28, pageHeight = 841.89, margin = 36;
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg  = await doc.embedFont(StandardFonts.Helvetica);

  // Compact sizes
  const titleSize = 15, subSize = 9.5, thSize = 9.5, tdSize = 9.5;
  const rowH = 14;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  // Helpers
  const widthOf = (f: any, sz: number, s: string) => f.widthOfTextAtSize(s, sz);
  const needPage = (need: number) => { if (y - need < margin) { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; } };
  const safe = (s: any) => (s ?? '').toString().replace(/\s+/g, ' ').trim();
  const ansi = (s: string) => safe(s).replace(/\u2192/g, '->').replace(/[\u2013\u2014]/g, '-');
  const dmy = (iso: string) => { const m = safe(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(-2)}` : safe(iso); };
  const inrInt = (n: number) => { const v = Math.round(n || 0); const s = Math.abs(v).toString(); if (s.length<=3) return (v<0?'-':'')+s; const head=s.slice(0,s.length-3), tail=s.slice(-3); return (v<0?'-':'')+head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')+','+tail; };

  const drawCell = (txt: string, x: number, w: number, align: 'L'|'R', sz: number, font: any) => {
    txt = ansi(txt);
    const maxChars = Math.max(3, Math.floor(w / (sz * 0.54)));
    if (txt.length > maxChars) txt = txt.slice(0, maxChars - 1) + '...';
    const tw = widthOf(font, sz, txt);
    const tx = align === 'R' ? (x + w - tw) : x;
    page.drawText(txt, { x: tx, y: y - sz, size: sz, font });
  };

  // Title & subtitle
  page.drawText('Dispatch Item-wise', { x: margin, y: y - titleSize, size: titleSize, font: fontBold });
  y -= titleSize + 5;
  page.drawText(ansi(heading), { x: margin, y: y - subSize, size: subSize, font: fontReg, color: rgb(0.2,0.2,0.2) });
  y -= subSize + 8;

  // Column sets per firm
  type Col = { k: string; label: string; w: number; align: 'L'|'R' };
  let cols: Col[] = [];

  if (org === 'MTM') {
    cols = [
      { k: 'inv',   label: 'Inv',   w: 70, align: 'L' },
      { k: 'date',  label: 'Date',  w: 50, align: 'L' },
      { k: 'item',  label: 'Item',  w: 90, align: 'L' }, // small
      { k: 'size',  label: 'Size',  w: 55, align: 'L' },
      { k: 'pack',  label: 'Pack',  w: 55, align: 'L' },
      { k: 'bale',  label: 'Bale',  w: 45, align: 'L' },
      { k: 'qty',   label: 'Qty',   w: 36, align: 'R' },
      { k: 'rate',  label: 'Rate',  w: 42, align: 'R' },
      { k: 'total', label: 'Total', w: 60, align: 'R' },
    ];
  } else if (org === 'PM') {
    cols = [
      { k: 'inv',   label: 'Inv',    w: 80, align: 'L' },
      { k: 'date',  label: 'Date',   w: 55, align: 'L' },
      { k: 'item',  label: 'Item',   w: 120, align: 'L' },
      { k: 'design',label: 'Design', w: 90, align: 'L' },  // cf_design_no
      { k: 'qty',   label: 'Qty',    w: 42, align: 'R' },
      { k: 'rate',  label: 'Rate',   w: 52, align: 'R' },
      { k: 'total', label: 'Total',  w: 60, align: 'R' },
    ];
  } else { // RMD / MURLI
    cols = [
      { k: 'inv',   label: 'Inv',   w: 80, align: 'L' },
      { k: 'date',  label: 'Date',  w: 55, align: 'L' },
      { k: 'item',  label: 'Item',  w: 110, align: 'L' },
      { k: 'desc',  label: 'Desc',  w: 110, align: 'L' },  // line item description
      { k: 'qty',   label: 'Qty',   w: 42, align: 'R' },
      { k: 'rate',  label: 'Rate',  w: 52, align: 'R' },
      { k: 'total', label: 'Total', w: 60, align: 'R' },
    ];
  }

  const x0 = margin;
  const tableW = cols.reduce((a, c) => a + c.w, 0);

  // Header ONCE (does not repeat)
  needPage(thSize + 4);
  let x = x0;
  for (const c of cols) { page.drawText(c.label, { x, y: y - thSize, size: thSize, font: fontBold }); x += c.w; }
  y -= thSize + 3;
  page.drawLine({ start: { x: x0, y }, end: { x: x0 + tableW, y }, thickness: 0.5, color: rgb(0.8,0.8,0.8) });
  y -= 3;

  for (const g of groups) {
    const invNo   = ansi(g.invoiceNo);
    const invDate = dmy(g.invoiceDate);
    const invTot  = inrInt(Number(g.total || 0));

    for (let i = 0; i < g.items.length; i++) {
      const it = g.items[i];
      const cells: Record<string, string> = {
        inv: invNo,
        date: invDate,
        item: safe(it.itemName),
        qty: String(Math.round(Number(it.qty || 0))),
        rate: Number(it.rate ?? 0).toFixed(2),
        total: i === 0 ? invTot : '',
      };

      if (org === 'MTM') {
        cells.size = safe(it.size1 || '');
        cells.pack = safe(it.packing || '');
        cells.bale = safe(it.baleNo || '');
      } else if (org === 'PM') {
        cells.design = safe(it.designNo || '');
      } else { // RMD/MURLI
        cells.desc = safe(it.description || '');
      }

      needPage(tdSize + 4);
      x = x0;
      for (const c of cols) {
        drawCell(cells[c.k] ?? '', x, c.w, c.align, tdSize, fontReg);
        x += c.w;
      }
      y -= rowH;
    }

    // Optional LR (after each invoice)
    if (showLRDetails) {
      const lr  = safe(g.lrNo) || '-';
      const lrd = g.lrDate ? dmy(g.lrDate) : '-';
      const tr  = safe(g.transport) || '-';
      needPage(tdSize + 3);
      page.drawText(`LR No - ${ansi(lr)}   LR Dt - ${ansi(lrd)}   Transport - ${ansi(tr)}`, {
        x: x0, y: y - tdSize, size: tdSize, font: fontReg, color: rgb(0.2,0.2,0.2)
      });
      y -= rowH - 2;
    }

    // Thin divider after each invoice block (helps readability)
    page.drawLine({
      start: { x: x0, y },
      end: { x: x0 + tableW, y },
      thickness: 0.4,
      color: rgb(0.85, 0.85, 0.85),
    });
    y -= 4;
  }

  return doc.save();
}
