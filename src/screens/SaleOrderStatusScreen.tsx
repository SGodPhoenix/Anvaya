// src/screens/SaleOrderStatusScreen.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import {
  Card,
  Text,
  Divider,
  IconButton,
  Chip,
  Searchbar,
  Portal,
  Modal,
  ActivityIndicator,
  Button,
} from 'react-native-paper';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';

import {
  fetchSaleOrderStatusMTM,
  listMTMCustomers,
  type SOStatusSO,
  type SOStatusLine,
} from '../lib/zoho';

type Props = NativeStackScreenProps<RootStackParamList, 'SaleOrderStatus'>;

// -------- utils --------
function fmtDate(d: string | Date | undefined | null): string {
  if (!d) return '-';
  const dt = typeof d === 'string' ? new Date(d) : d;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function rangeLast6Months() {
  const to = new Date();
  const from = new Date(to.getTime());
  from.setMonth(from.getMonth() - 6);
  const toISO = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(
    to.getDate(),
  ).padStart(2, '0')}`;
  const fromISO = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(
    from.getDate(),
  ).padStart(2, '0')}`;
  return { fromISO, toISO, from, to };
}

function fmtQty(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function escapeHtml(s: any) {
  const t = String(s ?? '');
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -------- screen --------
export default function SaleOrderStatusScreen({ navigation }: Props) {
  const [{ fromISO, toISO, from, to }] = useState(rangeLast6Months);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SOStatusSO[]>([]);

  // customers + picker
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [customerName, setCustomerName] = useState<string>('All Customers');

  // inline filter (only for All)
  const [inlineQuery, setInlineQuery] = useState('');

  // modal picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  // pdf
  const [pdfBusy, setPdfBusy] = useState(false);

  // Terminal
  const [logs, setLogs] = useState<string[]>([]);
  const [showTerm, setShowTerm] = useState(true);
  const termRef = useRef<ScrollView>(null);
  const pushLog = useCallback((msg: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setLogs(prev => (prev.length > 300 ? [...prev.slice(-300), line] : [...prev, line]));
    console.log('[SO-Status]', msg);
    setTimeout(() => termRef.current?.scrollToEnd({ animated: true }), 0);
  }, []);

  const dateLabel = useMemo(() => `${fmtDate(from)} to ${fmtDate(to)}`, [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      pushLog(`Load start • range=${fromISO}..${toISO} • customerId=${customerId ?? 'ALL'}`);

      if (!customers.length) {
        const custs = await listMTMCustomers();
        pushLog(`Fetched customers: ${custs.length}`);
        setCustomers(custs);
      }
      const result = await fetchSaleOrderStatusMTM(
        { from: fromISO, to: toISO, customerId },
        (s) => pushLog(s)
      );
      pushLog(`Fetched SOs: ${result.length}`);
      setData(result);
    } catch (e: any) {
      const msg = e?.message || 'Failed to load';
      setError(msg);
      pushLog(`ERROR: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [customerId, customers.length, fromISO, toISO, pushLog]);

  useEffect(() => { navigation.setOptions({ title: 'Sale Order Status (MTM)' }); }, [navigation]);
  useEffect(() => { load(); }, [load, customerId, fromISO, toISO]);

  const viewData = useMemo(() => {
    if (!inlineQuery || customerId) return data;
    const q = inlineQuery.toLowerCase();
    return data.filter((so) => so.customer_name.toLowerCase().includes(q));
  }, [data, inlineQuery, customerId]);

  const pickList = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(q));
  }, [customers, pickerQuery]);

  async function onMakePdf() {
    try {
      setPdfBusy(true);
      pushLog('PDF: building...');
      const html = buildHtml(viewData, { title: 'Sale Order Status (MTM)', dateLabel, customerName });
      const { uri } = await Print.printToFileAsync({ html });
      pushLog(`PDF: file created at ${uri}`);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) await Sharing.shareAsync(uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
    } catch (e: any) {
      pushLog(`PDF ERROR: ${e?.message || e}`);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Top card (Pending Dispatch style) */}
      <Card style={{ margin: 12 }}>
        <Card.Content style={styles.topRow}>
          <View style={{ flex: 1 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>Sale Order Status</Text>
            <Text variant="labelMedium" style={{ opacity: 0.7 }}>Last 6 months {dateLabel}</Text>
          </View>

          <IconButton icon="refresh" onPress={load} />
          <IconButton icon="file-pdf-box" onPress={onMakePdf} disabled={pdfBusy || loading || viewData.length === 0} />
        </Card.Content>

        <Divider />

        <Card.Content style={{ gap: 8 }}>
          <Text style={{ marginBottom: 4, opacity: 0.8 }}>Customer</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Chip icon="account" selected={!customerId}
              onPress={() => { setCustomerId(undefined); setCustomerName('All Customers'); pushLog('Filter: All'); }}>
              All Customers
            </Chip>

            <Chip icon="chevron-down" onPress={() => setPickerOpen(true)}>
              {customerId ? customerName : 'Tap to pick'}
            </Chip>
          </View>

          <Searchbar
            placeholder={customerId ? 'Customer filter disabled (specific customer selected)' : 'Search within customer name'}
            value={inlineQuery}
            onChangeText={(t) => { setInlineQuery(t); if (!customerId) pushLog(`Inline search: "${t}"`); }}
            editable={!customerId}
            style={{ marginTop: 8 }}
          />
        </Card.Content>
      </Card>

      {/* Body */}
      {loading ? (
        <View style={styles.centerFill}><ActivityIndicator /></View>
      ) : error ? (
        <View style={styles.centerFill}><Text>{error}</Text></View>
      ) : viewData.length === 0 ? (
        <View style={styles.centerFill}><Text>No sales orders in range.</Text></View>
      ) : (
        <FlatList
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
          data={viewData}
          keyExtractor={(so) => so.salesorder_id}
          contentContainerStyle={{ paddingHorizontal: 12 }}
          initialNumToRender={10}
          maxToRenderPerBatch={16}
          windowSize={11}
          removeClippedSubviews
          renderItem={({ item }) => <SOGroup so={item} />}
          ListFooterComponent={<View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ opacity: 0.7 }}>Sales Orders {viewData.length}</Text></View>}
        />
      )}

      {/* Terminal */}
      <Card style={styles.terminal}>
        <View style={styles.terminalHeader}>
          <Text style={{ fontWeight: '700' }}>Terminal</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <IconButton icon="delete" size={18} onPress={() => setLogs([])} />
            <IconButton icon={showTerm ? 'chevron-down' : 'chevron-up'} size={18} onPress={() => setShowTerm(v => !v)} />
          </View>
        </View>
        {showTerm && (
          <ScrollView ref={termRef} style={styles.terminalBody}>
            <Text selectable style={styles.termText}>{logs.length ? logs.join('\n') : '—'}</Text>
          </ScrollView>
        )}
      </Card>

      {/* Customer Picker */}
      <Portal>
        <Modal visible={pickerOpen} onDismiss={() => setPickerOpen(false)} contentContainerStyle={styles.modal}>
          <Text variant="titleMedium" style={{ fontWeight: '700', marginBottom: 8 }}>Select Customer</Text>
          <Searchbar placeholder="Type to search…" value={pickerQuery} onChangeText={setPickerQuery} style={{ marginBottom: 8 }} />
          <FlatList
            data={useMemo(() => {
              const q = pickerQuery.trim().toLowerCase();
              return q ? customers.filter(c => c.name.toLowerCase().includes(q)) : customers;
            }, [customers, pickerQuery])}
            keyExtractor={(x) => x.id}
            style={{ maxHeight: 360 }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TouchableOpacity onPress={() => {
                setCustomerId(item.id); setCustomerName(item.name); setPickerOpen(false);
                pushLog(`Picker: selected "${item.name}" (${item.id})`);
              }}>
                <View style={styles.pickRow}><Text numberOfLines={1} style={{ flex: 1 }}>{item.name}</Text></View>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <Divider />}
            ListEmptyComponent={<View style={{ padding: 16, alignItems: 'center' }}><Text>Nothing found</Text></View>}
          />
          <View style={{ height: 12 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Button onPress={() => { setCustomerId(undefined); setCustomerName('All Customers'); setPickerOpen(false); pushLog('Picker: cleared'); }}>
              Clear (All)
            </Button>
            <Button mode="contained" onPress={() => setPickerOpen(false)}>Done</Button>
          </View>
        </Modal>
      </Portal>
    </View>
  );
}

/** Collapsible SO group */
function SOGroup({ so }: { so: SOStatusSO }) {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.groupWrap}>
      <TouchableOpacity onPress={() => setOpen(v => !v)} activeOpacity={0.7}>
        <View style={styles.groupHeader}>
          <Text numberOfLines={2} style={{ flex: 1, fontWeight: '600' }}>
            {so.customer_name} — {so.salesorder_number} — {fmtDate(so.date)}
          </Text>
          <IconButton icon={open ? 'chevron-up' : 'chevron-down'} size={20} onPress={() => setOpen(v => !v)} />
        </View>
      </TouchableOpacity>

      {open && (
        <Card style={styles.groupCard}>
          <View style={[styles.row, styles.headerRow]}>
            <Text style={[styles.cell, styles.cellItem, styles.headerText]}>Item (cf_item_name)</Text>
            <Text style={[styles.cell, styles.headerText]}>Qty</Text>
            <Text style={[styles.cell, styles.headerText]}>Disp Qty</Text>
            <Text style={[styles.cell, styles.headerText]}>Inv</Text>
            <Text style={[styles.cell, styles.headerText]}>Date</Text>
            <Text style={[styles.cell, styles.headerText]}>LR no</Text>
            <Text style={[styles.cell, styles.headerText]}>LR Date</Text>
            <Text style={[styles.cell, styles.headerText]}>Transport</Text>
          </View>
          <Divider />
          {so.lines.map((ln) => <LineBlock key={ln.salesorder_item_id} line={ln} />)}
        </Card>
      )}
    </View>
  );
}

function LineBlock({ line }: { line: SOStatusLine }) {
  const bg =
    line.dispQty >= line.quantity - 1e-6 ? 'rgba(46, 204, 113, 0.16)' :
    line.dispQty > 0 ? 'rgba(241, 196, 15, 0.16)' :
    'rgba(231, 76, 60, 0.16)';

  const first = line.events[0];

  return (
    <View>
      <View style={[styles.row, { backgroundColor: bg }]}>
        <Text style={[styles.cell, styles.cellItem]} numberOfLines={1}>{line.item}</Text>
        <Text style={styles.cell}>{fmtQty(line.quantity)}</Text>
        <Text style={styles.cell}>{fmtQty(line.dispQty)}</Text>
        <Text style={styles.cell}>{first?.invoice_number ?? '-'}</Text>
        <Text style={styles.cell}>{fmtDate(first?.date)}</Text>
        <Text style={styles.cell}>{first?.lrNo ?? '-'}</Text>
        <Text style={styles.cell}>{fmtDate(first?.lrDate)}</Text>
        <Text style={styles.cell}>{first?.transport ?? '-'}</Text>
      </View>

      {line.events.slice(1).map((ev) => (
        <View key={`${ev.invoice_id}-${ev.date}`} style={styles.rowSub}>
          <Text style={[styles.cell, styles.cellItem]}>{' '}</Text>
          <Text style={styles.cell}>{' '}</Text>
          <Text style={styles.cell}>{' '}</Text>
          <Text style={styles.cell}>{ev.invoice_number}</Text>
          <Text style={styles.cell}>{fmtDate(ev.date)}</Text>
          <Text style={styles.cell}>{ev.lrNo ?? '-'}</Text>
          <Text style={styles.cell}>{fmtDate(ev.lrDate)}</Text>
          <Text style={styles.cell}>{ev.transport ?? '-'}</Text>
        </View>
      ))}

      <Divider style={{ opacity: 0.35 }} />
    </View>
  );
}

// -------- PDF html --------
function buildHtml(sos: SOStatusSO[], meta: { title: string; dateLabel: string; customerName: string }) {
  const styles = `
    <style>
      body { font-family: -apple-system, Roboto, Arial, sans-serif; margin: 24px; }
      h1 { font-size: 18px; margin: 0 0 2px 0; }
      .muted { color: #666; font-size: 12px; }
      .group { margin-top: 16px; page-break-inside: avoid; }
      table { width: 100%; border-collapse: collapse; margin-top: 6px; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 12px; }
      th { background: #f6f6f6; text-align: left; }
      .sub { background: #fafafa; }
      .ok { background: rgba(46, 204, 113, 0.16); }
      .mid { background: rgba(241, 196, 15, 0.16); }
      .no  { background: rgba(231, 76, 60, 0.16); }
    </style>
  `;
  const head = `<h1>${meta.title}</h1><div class="muted">${escapeHtml(meta.customerName)} • ${escapeHtml(meta.dateLabel)}</div>`;

  const groups = sos.map(so => {
    const rows = so.lines.map(ln => {
      const cls = ln.dispQty >= ln.quantity - 1e-6 ? 'ok' : ln.dispQty > 0 ? 'mid' : 'no';
      const f = ln.events[0];
      const main = `
        <tr class="${cls}">
          <td>${escapeHtml(ln.item)}</td>
          <td>${fmtQty(ln.quantity)}</td>
          <td>${fmtQty(ln.dispQty)}</td>
          <td>${f ? escapeHtml(f.invoice_number) : '-'}</td>
          <td>${f ? escapeHtml(fmtDate(f.date)) : '-'}</td>
          <td>${f?.lrNo ? escapeHtml(f.lrNo) : '-'}</td>
          <td>${f?.lrDate ? escapeHtml(fmtDate(f.lrDate)) : '-'}</td>
          <td>${f?.transport ? escapeHtml(f.transport) : '-'}</td>
        </tr>
      `;
      const subs = ln.events.slice(1).map(ev => `
        <tr class="sub">
          <td></td><td></td><td></td>
          <td>${escapeHtml(ev.invoice_number)}</td>
          <td>${escapeHtml(fmtDate(ev.date))}</td>
          <td>${ev.lrNo ? escapeHtml(ev.lrNo) : '-'}</td>
          <td>${ev.lrDate ? escapeHtml(fmtDate(ev.lrDate)) : '-'}</td>
          <td>${ev.transport ? escapeHtml(ev.transport) : '-'}</td>
        </tr>`).join('');
      return main + subs;
    }).join('');

    return `
      <div class="group">
        <div><b>${escapeHtml(so.customer_name)}</b> — ${escapeHtml(so.salesorder_number)} — ${escapeHtml(fmtDate(so.date))}</div>
        <table>
          <thead>
            <tr>
              <th>Item (cf_item_name)</th><th>Qty</th><th>Disp Qty</th><th>Inv</th>
              <th>Date</th><th>LR no</th><th>LR Date</th><th>Transport</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8" />${styles}</head><body>${head}${groups}</body></html>`;
}

// -------- styles --------
const styles = StyleSheet.create({
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupWrap: { marginBottom: 6, marginHorizontal: 4 },
  groupHeader: {
    backgroundColor: 'white', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', elevation: 1,
  },
  groupCard: { borderRadius: 12, overflow: 'hidden', marginTop: 6 },
  headerRow: { backgroundColor: 'rgba(0,0,0,0.04)' },
  headerText: { fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  rowSub: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, gap: 8, backgroundColor: 'rgba(0,0,0,0.02)' },
  cell: { flex: 1 },
  cellItem: { flex: 2, paddingRight: 8 },
  modal: { margin: 16, backgroundColor: 'white', padding: 16, borderRadius: 16 },
  pickRow: { paddingHorizontal: 8, paddingVertical: 12 },
  terminal: { marginHorizontal: 12, marginTop: 6, marginBottom: 10, borderRadius: 12, overflow: 'hidden' },
  terminalHeader: { paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center' },
  terminalBody: { height: 140, backgroundColor: '#0b0f17', paddingHorizontal: 12, paddingVertical: 8 },
  termText: { color: '#c7d2fe', fontSize: 12, lineHeight: 16, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: undefined }) },
});
