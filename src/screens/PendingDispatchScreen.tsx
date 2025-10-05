import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView } from 'react-native';
import {
  Text, Button, Card, Divider, IconButton, ActivityIndicator,
  Portal, Modal, Searchbar, Snackbar, Chip, Checkbox
} from 'react-native-paper';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as FSLegacy from 'expo-file-system/legacy';
import * as XLSX from 'xlsx';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  last12MonthsRange,
  fetchPendingDispatchMTM,
  type PendingRow
} from '../lib/zoho';
import { ensureDir, uniqueName } from '../lib/utils';

const CACHE_KEY = 'pending_mtm_v2';

type SummaryRow =
  | {
      // showExtras = true
      mode: 'withExtras';
      dateISO: string;
      dateStr: string;
      so: string;
      itemCode: string;
      bales: number;
      qty: number;
      amount: number;
    }
  | {
      // showExtras = false
      mode: 'simple';
      itemCode: string;
      bales: number;
      qty: number;
      amount: number;
    };

export default function PendingDispatchScreen() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [snack, setSnack] = useState({ visible: false, msg: '' });
  const [log, setLog] = useState<string[]>([]);
  const [customerModal, setCustomerModal] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<string>(''); // empty = ALL
  const [showExtras, setShowExtras] = useState<boolean>(false); // default OFF per request

  const logRef = useRef<ScrollView>(null);
  const appendLog = (s: string) => setLog((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${s}`]);

  // Load cached data on mount
  useEffect(() => {
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          const obj = JSON.parse(cached);
          if (Array.isArray(obj?.rows)) {
            setRows(obj.rows);
            appendLog(`Loaded cached rows: ${obj.rows.length}`);
          }
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => logRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [log]);

  const customers = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.Customer || ''));
    const arr = Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b));
    return arr;
  }, [rows]);

  const range = useMemo(() => last12MonthsRange(), []);
  const subtitleLabel = `Last 12 months ${range.start} to ${range.end} (MTM)`;

  // Filter by customer (or all)
  const filteredRows = useMemo(() => {
    if (!selectedCustomer) return rows;
    return rows.filter(
      (r) => (r.Customer || '').trim().toLowerCase() === selectedCustomer.trim().toLowerCase()
    );
  }, [rows, selectedCustomer]);

  // Build summary depending on toggle
  const summary = useMemo<SummaryRow[]>(() => {
    if (filteredRows.length === 0) return [];

    if (showExtras) {
      // Group by Date + SO + ItemCode
      const map = new Map<string, SummaryRow & { _dateISO: string; _dateStr: string; _so: string }>();
      for (const r of filteredRows) {
        const key = `${r.DateISO}|${r.SO}|${r.ItemCode || r.Item || 'UNKNOWN'}`;
        const cur =
          (map.get(key) as any) ||
          ({
            mode: 'withExtras',
            dateISO: r.DateISO || '',
            dateStr: r.DateStr || '',
            so: r.SO || '',
            itemCode: r.ItemCode || r.Item || 'UNKNOWN',
            bales: 0,
            qty: 0,
            amount: 0,
          } as SummaryRow);
        cur.bales += 1;
        cur.qty += Number(r.PendingQty || 0);
        cur.amount += Number(r.Amount || 0);
        map.set(key, cur);
      }
      const out = Array.from(map.values()) as SummaryRow[];
      // Sort: Date asc → SO asc → ItemCode asc
      out.sort((a, b) => {
        const A = a as Extract<SummaryRow, { mode: 'withExtras' }>;
        const B = b as Extract<SummaryRow, { mode: 'withExtras' }>;
        return (
          (A.dateISO || '').localeCompare(B.dateISO || '') ||
          (A.so || '').localeCompare(B.so || '') ||
          (A.itemCode || '').localeCompare(B.itemCode || '')
        );
      });
      return out;
    }

    // Simple mode: group only by ItemCode
    const map = new Map<string, SummaryRow>();
    for (const r of filteredRows) {
      const key = r.ItemCode || r.Item || 'UNKNOWN';
      const cur =
        map.get(key) ||
        ({
          mode: 'simple',
          itemCode: key,
          bales: 0,
          qty: 0,
          amount: 0,
        } as SummaryRow);
      cur.bales += 1;
      cur.qty += Number(r.PendingQty || 0);
      cur.amount += Number(r.Amount || 0);
      map.set(key, cur);
    }
    const out = Array.from(map.values());
    out.sort((a, b) => a.itemCode.localeCompare(b.itemCode));
    return out;
  }, [filteredRows, showExtras]);

  const totals = useMemo(() => {
    return summary.reduce(
      (acc, r) => {
        acc.bales += r.bales;
        acc.qty += r.qty;
        acc.amount += r.amount;
        return acc;
      },
      { bales: 0, qty: 0, amount: 0 }
    );
  }, [summary]);

  const onRefresh = async () => {
    setIsWorking(true);
    setLog([]);
    appendLog(`Fetching pending (MTM) for last 12 months…`);
    try {
      const fresh = await fetchPendingDispatchMTM((s) => appendLog(s));
      setRows(fresh);
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ rows: fresh, cachedAt: Date.now() }));
      setSnack({ visible: true, msg: `✅ Loaded ${fresh.length} rows` });
      appendLog(`Cached rows: ${fresh.length}`);
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ Error fetching' });
      appendLog(`❌ Error: ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  // ---------- NEW: Build & share a phone‑friendly PDF of CURRENT VIEW ----------
  const onDownloadPdf = async () => {
    if (summary.length === 0) {
      setSnack({ visible: true, msg: 'No data — please Refresh first' });
      return;
    }
    setIsWorking(true);
    setLog([]);
    appendLog('Building phone‑friendly PDF…');

    try {
      const bytes = await buildPendingSummaryPdf({
        title: 'Pending Dispatch',
        subtitle: subtitleLabel,
        customer: selectedCustomer || 'All Customers',
        showExtras,
        summary,
        totals,
      });

      // save
      const baseDir = FSLegacy.documentDirectory || FSLegacy.cacheDirectory;
      if (!baseDir) throw new Error('No writable directory available');
      const dir = baseDir + 'Anvaya/';
      await ensureDir(dir);

      const fileName = `Pending_Dispatch_${selectedCustomer ? selectedCustomer.replace(/[\\/:*?"<>|]/g,'_') + '_' : ''}${uniqueName()}.pdf`;
      const fileUri = dir + fileName;

      const b64 = btoa(String.fromCharCode(...bytes));
      await FSLegacy.writeAsStringAsync(fileUri, b64, { encoding: FSLegacy.EncodingType.Base64 });
      appendLog(`Saved → ${fileUri}`);

      // share
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri);
      }
      setSnack({ visible: true, msg: '✅ PDF ready — sharing…' });
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ PDF export failed' });
      appendLog(`❌ PDF error: ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  const onDownloadXlsx = async () => {
    try {
      if (rows.length === 0) {
        setSnack({ visible: true, msg: 'No data — please Refresh first' });
        return;
      }
      setIsWorking(true);
      setLog([]);
      appendLog('Building Excel workbook…');

      const wb = XLSX.utils.book_new();

      // Sheet1: Raw_Items
      const rawCols = [
        'Customer','DateStr','SO#','Item','Item Code','Packing','Rate','Pending Qty','Amount'
      ];
      const rawData = rows.map(r => ({
        'Customer': r.Customer,
        'DateStr': r.DateStr,
        'SO#': r.SO,
        'Item': r.Item,
        'Item Code': r.ItemCode,
        'Packing': r.Packing,
        'Rate': r.Rate,
        'Pending Qty': r.PendingQty,
        'Amount': r.Amount,
      }));
      const ws1 = XLSX.utils.json_to_sheet(rawData, { header: rawCols });
      autoFit(ws1, 40);
      XLSX.utils.book_append_sheet(wb, ws1, 'Raw_Items');

      // Sheet2: Customer_Totals (+ GRAND TOTAL)
      const custTotalsMap = new Map<string, { qty: number; amt: number }>();
      for (const r of rows) {
        const key = r.Customer || '';
        const cur = custTotalsMap.get(key) || { qty: 0, amt: 0 };
        cur.qty += Number(r.PendingQty || 0);
        cur.amt += Number(r.Amount || 0);
        custTotalsMap.set(key, cur);
      }
      const custTotalsArr = Array.from(custTotalsMap.entries()).map(([Customer, v]) => ({
        Customer,
        'Pending Qty': v.qty,
        'Amount': v.amt,
      }));
      const grandQty = custTotalsArr.reduce((a, r) => a + Number(r['Pending Qty'] || 0), 0);
      const grandAmt = custTotalsArr.reduce((a, r) => a + Number(r['Amount'] || 0), 0);
      custTotalsArr.push({ Customer: 'GRAND TOTAL', 'Pending Qty': grandQty, 'Amount': grandAmt });
      const ws2 = XLSX.utils.json_to_sheet(custTotalsArr, { header: ['Customer','Pending Qty','Amount'] });
      autoFit(ws2, 40);
      XLSX.utils.book_append_sheet(wb, ws2, 'Customer_Totals');

      // Sheet3: Cust_SO_Item (SO totals and customer totals)
      const custSoRows: any[] = [];
      const byCust = groupBy(rows, (r) => r.Customer || '');
      Object.keys(byCust).sort().forEach((cust) => {
        const bySO = groupBy(byCust[cust].sort((a,b)=> (a.SO||'').localeCompare(b.SO||'')), (r) => r.SO || '');
        Object.keys(bySO).forEach((so) => {
          const soRows = bySO[so];
          const soQty = soRows.reduce((a,r)=>a+Number(r.PendingQty||0),0);
          const soAmt = soRows.reduce((a,r)=>a+Number(r.Amount||0),0);
          // SO total row
          custSoRows.push({
            Customer: '',
            DateStr: '',
            'SO#': `${so} Total`,
            Item: '',
            'Item Code': '',
            Packing: '',
            Rate: '',
            'Pending Qty': soQty,
            Amount: soAmt,
          });
          // detail rows
          soRows.forEach((r)=> {
            custSoRows.push({
              Customer: r.Customer,
              DateStr: r.DateStr,
              'SO#': r.SO,
              Item: r.Item,
              'Item Code': r.ItemCode,
              Packing: r.Packing,
              Rate: r.Rate,
              'Pending Qty': r.PendingQty,
              Amount: r.Amount,
            });
          });
        });
        // customer total
        const cQty = byCust[cust].reduce((a,r)=>a+Number(r.PendingQty||0),0);
        const cAmt = byCust[cust].reduce((a,r)=>a+Number(r.Amount||0),0);
        custSoRows.push({
          Customer: `${cust} Total`,
          DateStr: '',
          'SO#': '',
          Item: '',
          'Item Code': '',
          Packing: '',
          Rate: '',
          'Pending Qty': cQty,
          Amount: cAmt,
        });
      });
      const ws3 = XLSX.utils.json_to_sheet(custSoRows, {
        header: ['Customer','DateStr','SO#','Item','Item Code','Packing','Rate','Pending Qty','Amount']
      });
      autoFit(ws3, 40);
      XLSX.utils.book_append_sheet(wb, ws3, 'Cust_SO_Item');

      // Sheet4: Item_Pack_Date
      const rowsSorted4 = [...rows].sort((a,b)=>{
        const ic = (a.ItemCode||'').localeCompare(b.ItemCode||'');
        if (ic !== 0) return ic;
        const pk = (a.Packing||'').localeCompare(b.Packing||'');
        if (pk !== 0) return pk;
        return (a.DateISO||'').localeCompare(b.DateISO||'');
      });
      const byItem = groupBy(rowsSorted4, (r)=> r.ItemCode || '');
      const itemRows: any[] = [];
      Object.keys(byItem).forEach((code) => {
        const totQty = byItem[code].reduce((a,r)=>a+Number(r.PendingQty||0),0);
        const totAmt = byItem[code].reduce((a,r)=>a+Number(r.Amount||0),0);
        itemRows.push({
          'Item Code': `${code} Total`,
          'Packing': '',
          'DateStr': '',
          'SO#': '',
          'Customer': '',
          'Rate': '',
          'Pending Qty': totQty,
          'Amount': totAmt
        });
        byItem[code].forEach((r)=> {
          itemRows.push({
            'Item Code': r.ItemCode,
            'Packing': r.Packing,
            'DateStr': r.DateStr,
            'SO#': r.SO,
            'Customer': r.Customer,
            'Rate': r.Rate,
            'Pending Qty': r.PendingQty,
            'Amount': r.Amount
          });
        });
      });
      const ws4 = XLSX.utils.json_to_sheet(itemRows, {
        header: ['Item Code','Packing','DateStr','SO#','Customer','Rate','Pending Qty','Amount']
      });
      autoFit(ws4, 40);
      XLSX.utils.book_append_sheet(wb, ws4, 'Item_Pack_Date');

      // Write workbook -> base64
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });

      // Save
      const baseDir = FSLegacy.documentDirectory || FSLegacy.cacheDirectory;
      if (!baseDir) throw new Error('No writable directory available');
      const dir = baseDir + 'Anvaya/';
      await ensureDir(dir);

      const fileName = `Pending_Dispatch_Last12M.xlsx`;
      const fileUri = dir + fileName;

      try {
        await FSLegacy.writeAsStringAsync(fileUri, wbout, { encoding: FSLegacy.EncodingType.Base64 });
        appendLog(`Saved → ${fileUri}`);
        await share(fileUri);
      } catch (err) {
        const tsName = `Pending_Dispatch_${uniqueName()}.xlsx`;
        const altUri = dir + tsName;
        appendLog(`Primary filename busy; saving as ${tsName}`);
        await FSLegacy.writeAsStringAsync(altUri, wbout, { encoding: FSLegacy.EncodingType.Base64 });
        appendLog(`Saved → ${altUri}`);
        await share(altUri);
      }
      setSnack({ visible: true, msg: '✅ Excel ready — sharing…' });
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ Export failed' });
      appendLog(`❌ Export error: ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:12 }}>
      {/* Header Card */}
      <Card style={{ borderRadius:16, overflow:'hidden' }}>
        <Card.Title
          title="📦 Pending Dispatch"
          subtitle={subtitleLabel}
          right={(props) => (
            <View style={{ flexDirection:'row', alignItems:'center' }}>
              {isWorking ? <ActivityIndicator style={{ marginRight: 8 }} /> : null}
              <IconButton {...props} icon="refresh" onPress={onRefresh} disabled={isWorking} />
              {/* NEW: Download current view as PDF */}
              <IconButton {...props} icon="file-pdf-box" onPress={onDownloadPdf} disabled={isWorking || summary.length===0} />
              {/* Existing Excel export */}
              <IconButton {...props} icon="download" onPress={onDownloadXlsx} disabled={isWorking || rows.length===0} />
            </View>
          )}
        />
        <Divider />
        <Card.Content>
          {/* Customer selector + toggle */}
          <Text style={{ marginTop: 8, marginBottom: 6 }}>Customer</Text>
          <View style={{ flexDirection:'row', flexWrap:'wrap', alignItems:'center' }}>
            <Chip
              icon="account"
              selected
              onPress={() => setCustomerModal(true)}
              style={{ alignSelf:'flex-start', marginRight:8 }}
            >
              {selectedCustomer ? selectedCustomer : 'All Customers'}
            </Chip>

            <View style={{ flexDirection:'row', alignItems:'center', marginLeft:4 }}>
              <Checkbox
                status={showExtras ? 'checked' : 'unchecked'}
                onPress={() => setShowExtras(v => !v)}
              />
              <Text>Show Date / SO No</Text>
            </View>
          </View>

          {/* Customer modal */}
          <Portal>
            <Modal
              visible={customerModal}
              onDismiss={() => setCustomerModal(false)}
              contentContainerStyle={{
                backgroundColor:'white', margin:16, borderRadius:12, padding:12, maxHeight:'80%'
              }}
            >
              <Text variant="titleMedium" style={{ marginBottom:8 }}>Select Customer</Text>
              <Searchbar
                placeholder="Search customers…"
                value={custQuery}
                onChangeText={setCustQuery}
                style={{ marginBottom:8 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
              <View style={{ maxHeight:'65%' }}>
                <ScrollView keyboardShouldPersistTaps="handled">
                  <Button
                    mode={!selectedCustomer ? 'contained' : 'outlined'}
                    style={{ marginBottom:8 }}
                    onPress={() => { setSelectedCustomer(''); setCustomerModal(false); }}
                  >
                    All Customers
                  </Button>
                  {customers
                    .filter(c => c.toLowerCase().includes(custQuery.trim().toLowerCase()))
                    .map((c) => (
                      <Button
                        key={c}
                        mode={selectedCustomer === c ? 'contained' : 'outlined'}
                        style={{ marginBottom:8 }}
                        onPress={() => { setSelectedCustomer(c); setCustomerModal(false); }}
                      >
                        {c}
                      </Button>
                    ))}
                </ScrollView>
              </View>
              <View style={{ flexDirection:'row', justifyContent:'space-between', marginTop:8 }}>
                <Button onPress={() => setCustQuery('')} icon="close">Clear</Button>
                <Button onPress={() => setCustomerModal(false)}>Close</Button>
              </View>
            </Modal>
          </Portal>
        </Card.Content>
      </Card>

      {/* Summary Card */}
      <Card style={{ marginTop:16, borderRadius:16 }}>
        <Card.Title
          title={selectedCustomer ? `Summary — ${selectedCustomer}` : 'Summary — All Customers'}
          subtitle={
            showExtras
              ? 'Date, SO No, Item (Code), Bales, Quantity, Amount'
              : 'Item (Code), Bales, Quantity, Amount'
          }
        />
        <Divider />
        <Card.Content>
          {summary.length === 0 ? (
            <Text>No data loaded. Tap Refresh.</Text>
          ) : (
            <ScrollView horizontal>
              <View style={{ paddingVertical:6 }}>
                {/* Header Row */}
                <View style={{ flexDirection:'row', paddingVertical:8 }}>
                  {showExtras && <HeaderCell text="Date" width={110} />}
                  {showExtras && <HeaderCell text="SO No" width={120} />}
                  <HeaderCell text="Item (Code)" width={160} />
                  <HeaderCell text="Bales" width={70} />
                  <HeaderCell text="Quantity" width={90} />
                  <HeaderCell text="Amount" width={110} />
                </View>
                <Divider />

                {/* Data Rows */}
                {summary.map((r, idx) => {
                  if (r.mode === 'withExtras') {
                    return (
                      <View key={`${idx}-${r.dateISO}-${r.so}-${r.itemCode}`} style={{ flexDirection:'row', paddingVertical:8 }}>
                        <Cell text={r.dateStr || '-'} width={110} />
                        <Cell text={r.so || '-'} width={120} />
                        <Cell text={r.itemCode || '-'} width={160} />
                        <Cell text={String(r.bales)} width={70} />
                        <Cell text={String(r.qty)} width={90} />
                        <Cell text={r.amount.toFixed(2)} width={110} />
                      </View>
                    );
                  }
                  // simple
                  return (
                    <View key={`${idx}-${r.itemCode}`} style={{ flexDirection:'row', paddingVertical:8 }}>
                      <Cell text={r.itemCode || '-'} width={160} />
                      <Cell text={String(r.bales)} width={70} />
                      <Cell text={String(r.qty)} width={90} />
                      <Cell text={r.amount.toFixed(2)} width={110} />
                    </View>
                  );
                })}

                {/* Totals */}
                <Divider />
                <View style={{ flexDirection:'row', paddingVertical:10 }}>
                  {showExtras && <HeaderCell text="—" width={110} />}
                  {showExtras && <HeaderCell text="—" width={120} />}
                  <HeaderCell text="TOTAL" width={160} />
                  <HeaderCell text={String(totals.bales)} width={70} />
                  <HeaderCell text={String(totals.qty)} width={90} />
                  <HeaderCell text={totals.amount.toFixed(2)} width={110} />
                </View>
              </View>
            </ScrollView>
          )}
        </Card.Content>
      </Card>

      {/* Activity */}
      <Card style={{ marginTop:16, borderRadius:16, marginBottom:20 }}>
        <Card.Title title="📡 Activity" subtitle="Live log" />
        <Divider />
        <Card.Content>
          {log.length === 0 ? (
            <Text>Idle.</Text>
          ) : (
            <View style={{ height: 200 }}>
              <ScrollView ref={logRef}>
                {log.map((line, idx) => (
                  <Text key={`${idx}-${line}`} style={{ marginBottom:4 }}>{line}</Text>
                ))}
              </ScrollView>
            </View>
          )}
        </Card.Content>
      </Card>

      <Snackbar
        visible={snack.visible}
        onDismiss={() => setSnack({ visible: false, msg: '' })}
        duration={2500}
      >
        {snack.msg}
      </Snackbar>
    </ScrollView>
  );
}

/* ---------- Small Table Components ---------- */
function HeaderCell({ text, width }: { text: string; width: number }) {
  return (
    <View style={{ width, paddingRight:12 }}>
      <Text variant="labelLarge">{text}</Text>
    </View>
  );
}
function Cell({ text, width }: { text: string; width: number }) {
  return (
    <View style={{ width, paddingRight:12 }}>
      <Text>{text}</Text>
    </View>
  );
}

/* ---------- Helpers (Excel + Saving) ---------- */
function groupBy<T>(arr: T[], keyFn: (t: T) => string) {
  return arr.reduce<Record<string, T[]>>((acc, cur) => {
    const k = keyFn(cur);
    (acc[k] = acc[k] || []).push(cur);
    return acc;
  }, {});
}
function autoFit(ws: XLSX.WorkSheet, maxWidth = 40) {
  const cols = [];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  for (let C = range.s.c; C <= range.e.c; ++C) {
    let max = 10;
    for (let R = range.s.r; R <= range.e.r; ++R) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      const v = cell?.v;
      const l = typeof v === 'number' ? v.toString().length : (v ? String(v).length : 0);
      if (l > max) max = l;
    }
    cols.push({ wch: Math.min(max + 2, maxWidth) });
  }
  (ws as any)['!cols'] = cols;
}
async function share(uri: string) {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
}

/* ---------- NEW: PDF builder for current view ---------- */
async function buildPendingSummaryPdf(opts: {
  title: string;
  subtitle: string;
  customer: string;
  showExtras: boolean;
  summary: SummaryRow[];
  totals: { bales: number; qty: number; amount: number };
}): Promise<Uint8Array> {
  const { title, subtitle, customer, showExtras, summary, totals } = opts;

  // A4 portrait
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 28;
  const marginY = 28;

  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  const titleSize = 16;
  const subSize = 10;
  const headerSize = 11;
  const cellSize = 10;
  const rowH = 18;

  // define columns for current view
  const columns = showExtras
    ? [
        { key: 'dateStr', label: 'Date', width: 90 },
        { key: 'so', label: 'SO No', width: 90 },
        { key: 'itemCode', label: 'Item (Code)', width: 150 },
        { key: 'bales', label: 'Bales', width: 60 },
        { key: 'qty', label: 'Quantity', width: 70 },
        { key: 'amount', label: 'Amount', width: 80 },
      ]
    : [
        { key: 'itemCode', label: 'Item (Code)', width: 180 },
        { key: 'bales', label: 'Bales', width: 60 },
        { key: 'qty', label: 'Quantity', width: 80 },
        { key: 'amount', label: 'Amount', width: 90 },
      ];

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginY;

  // Header
  page.drawText(title, { x: marginX, y: y - titleSize, size: titleSize, font: fontBold });
  y -= titleSize + 4;

  page.drawText(subtitle, { x: marginX, y: y - subSize, size: subSize, font: fontReg, color: rgb(0.25,0.25,0.25) });
  y -= subSize + 2;

  page.drawText(`Customer: ${customer}`, { x: marginX, y: y - subSize, size: subSize, font: fontReg, color: rgb(0.25,0.25,0.25) });
  y -= subSize + 10;

  const drawHeader = () => {
    let x = marginX;
    columns.forEach((c) => {
      page.drawText(c.label, { x, y: y - headerSize, size: headerSize, font: fontBold });
      x += c.width;
    });
    y -= headerSize + 4;
    page.drawLine({
      start: { x: marginX, y },
      end: { x: pageWidth - marginX, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 6;
  };

  const drawRow = (r: SummaryRow) => {
    let x = marginX;

    const valOf = (key: string) => {
      // @ts-ignore
      return r[key];
    };

    for (const col of columns) {
      let text: string;
      const v = valOf(col.key);
      if (typeof v === 'number') {
        text = col.key === 'amount' ? v.toFixed(2) : String(v);
      } else {
        text = String(v ?? '');
      }

      // simple truncation
      const maxChars = Math.max(3, Math.floor(col.width / (cellSize * 0.55)));
      if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';

      page.drawText(text || '-', { x, y: y - cellSize, size: cellSize, font: fontReg });
      x += col.width;
    }

    y -= rowH;
  };

  drawHeader();

  for (const r of summary) {
    if (y < marginY + 40) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - marginY;
      drawHeader();
    }
    drawRow(r);
  }

  // Totals
  if (y < marginY + 40) {
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - marginY;
  }
  page.drawLine({
    start: { x: marginX, y },
    end: { x: pageWidth - marginX, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 14;

  const totalsText = `TOTAL  |  Bales: ${totals.bales}   Qty: ${totals.qty}   Amount: ${totals.amount.toFixed(2)}`;
  page.drawText(totalsText, { x: marginX, y: y - cellSize, size: cellSize, font: fontBold });

  return await doc.save();
}
