// src/screens/NewSaleOrderScreen.tsx
import React, { useEffect, useMemo, useState, useLayoutEffect } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  Platform,
  Pressable,
  Share,
} from 'react-native';
import {
  Button,
  Text,
  TextInput,
  Card,
  IconButton,
  HelperText,
  ActivityIndicator,
  Divider,
  Portal,
  Dialog,
  Chip,
  Switch,
} from 'react-native-paper';
import * as Sharing from 'expo-sharing';

import {
  refreshPriceBook,
  loadCachedPriceBook,
  type NormalizedRow,
} from '../lib/pricebook';
import {
  fetchActiveCustomersWithPriceListMTM,
  createSalesOrderMTM,
  fetchSalespersonsMTM,
  downloadSalesOrderPdfMTM,
} from '../lib/zoho';

/** Types */
type Customer = { id: string; name: string; priceList: 'Exmill' | 'Nett' | '' };
type SalesPerson = { id: string; name: string };

type Line = {
  id: string;
  cf_item_name: string;
  cf_size_1: string;
  cf_packing: string;
  qty: string;
  rate: string;
};

type LogLevel = 'INFO' | 'WARN' | 'ERROR';
type LogRow = { ts: number; lvl: LogLevel; tag: string; msg: string; meta?: any };

const styles = StyleSheet.create({
  page: { padding: 12, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  tinyRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  itemArea: { flexBasis: 190, flexGrow: 0, flexShrink: 0 },
  sizeArea: { flexBasis: 140, flexGrow: 0, flexShrink: 0 },
  packArea: { flexBasis: 120, flexGrow: 0, flexShrink: 0 },
  qtyArea: { flexBasis: 72, flexGrow: 0, flexShrink: 0 },
  rateArea: { flexBasis: 84, flexGrow: 0, flexShrink: 0 },

  itemFull: { flexGrow: 1 },
  chip: { height: 36, alignItems: 'center' },
  compactInput: { height: 40 },

  monoBox: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    backgroundColor: '#0b1020',
    color: '#d7e1ff',
    padding: 10,
    borderRadius: 8,
  },
});

/** Utils */
const uid = () => Math.random().toString(36).slice(2, 9);
const chipTextStyle = (t: string, base = 13) => ({
  fontSize:
    t && t.length > 24
      ? base - 3
      : t && t.length > 18
      ? base - 2
      : t && t.length > 12
      ? base - 1
      : base,
});
function sanitizeItemId(raw: any): string {
  if (raw == null) return '';
  const s = String(raw).trim();
  return s.replace(/[^\d]/g, '');
}
function isValidItemId(id: string): boolean {
  return /^\d{12,}$/.test(id);
}

/* ----------------------------- generic picker ----------------------------- */
function SearchableListDialog<T extends { id: string; name: string }>({
  title,
  visible,
  onClose,
  onPick,
  options,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  onPick: (v: T) => void;
  options: T[];
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () => options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase())),
    [q, options]
  );
  return (
    <Portal>
      <Dialog visible={visible} onDismiss={() => { onClose(); setQ(''); }}>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Content>
          <TextInput
            mode="outlined"
            dense
            label="Search"
            value={q}
            onChangeText={setQ}
            style={{ marginBottom: 8 }}
          />
          <ScrollView style={{ maxHeight: 360 }}>
            {filtered.length ? (
              filtered.map((opt) => (
                <Button
                  key={opt.id}
                  compact
                  onPress={() => {
                    onPick(opt);
                    onClose();
                    setQ('');
                  }}
                  style={{ marginBottom: 6 }}
                >
                  {opt.name}
                </Button>
              ))
            ) : (
              <Text style={{ opacity: 0.6 }}>No options</Text>
            )}
          </ScrollView>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={() => { onClose(); setQ(''); }}>Close</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

/* ------------------------------- Dev console ------------------------------ */
const DevTerminal: React.FC<{
  open: boolean;
  setOpen: (v: boolean) => void;
  logs: LogRow[];
  onClear: () => void;
}> = ({ open, setOpen, logs, onClear }) => {
  const mono = Platform.select({ ios: 'Menlo', android: 'monospace' });
  const ref = React.useRef<ScrollView>(null);
  useEffect(() => {
    ref.current?.scrollToEnd({ animated: true });
  }, [logs.length]);

  const toLines = () =>
    logs
      .map((l) => {
        const t = new Date(l.ts);
        const hh = t.getHours().toString().padStart(2, '0');
        const mm = t.getMinutes().toString().padStart(2, '0');
        const ss = t.getSeconds().toString().padStart(2, '0');
        const meta = l.meta ? `  ${JSON.stringify(l.meta).slice(0, 400)}` : '';
        return `[${hh}:${mm}:${ss}] [${l.lvl}] [${l.tag}] ${l.msg}${meta}`;
      })
      .join('\n');

  const shareLogs = async () => {
    try {
      await Share.share({ message: toLines() || '(no logs)' });
    } catch {}
  };

  return (
    <View
      style={{
        marginTop: 12,
        borderRadius: 10,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: '#334155',
      }}
    >
      <Pressable
        onPress={() => setOpen(!open)}
        style={{
          backgroundColor: '#0b1020',
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text style={{ color: '#93c5fd', fontWeight: '600' }}>
          {open ? '▼' : '►'} Debug console — {logs.length}{' '}
          {logs.length === 1 ? 'line' : 'lines'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Pressable onPress={shareLogs}>
            <Text style={{ color: '#a7f3d0' }}>Share</Text>
          </Pressable>
          <Pressable onPress={onClear}>
            <Text style={{ color: '#fecaca' }}>Clear</Text>
          </Pressable>
        </View>
      </Pressable>

      {open && (
        <View style={{ backgroundColor: '#0b1020' }}>
          <ScrollView ref={ref} style={{ maxHeight: 180, padding: 12 }}>
            <Text
              selectable
              style={{ color: '#e5e7eb', fontFamily: mono, fontSize: 12, lineHeight: 18 }}
            >
              {toLines() || '— no logs yet —'}
            </Text>
          </ScrollView>
        </View>
      )}
    </View>
  );
};

/* -------------------------------- screen --------------------------------- */
function useHeaderRefresh(navigation: any, onRefresh: () => void) {
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'New Order',
      headerRight: () => (
        <IconButton
          icon="refresh"
          onPress={onRefresh}
          accessibilityLabel="Refresh price-book"
        />
      ),
    });
  }, [navigation, onRefresh]);
}

export default function NewSaleOrderScreen({ navigation }: any) {
  const { width } = useWindowDimensions();
  const isCompact = width <= 520;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [rows, setRows] = useState<NormalizedRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [salespersons, setSalespersons] = useState<SalesPerson[]>([]);

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedSalesperson, setSelectedSalesperson] = useState<SalesPerson | null>(null);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [salesPickerOpen, setSalesPickerOpen] = useState(false);

  // cf_haste input
  const [haste, setHaste] = useState<string>('');

  // Lines
  const [lines, setLines] = useState<Line[]>(() =>
    Array.from({ length: 3 }).map(() => ({
      id: uid(),
      cf_item_name: '',
      cf_size_1: '',
      cf_packing: '',
      qty: '',
      rate: '',
    }))
  );
  const [pickerOpenFor, setPickerOpenFor] = useState<string | null>(null);

  // Debug & terminal
  const [debugOpen, setDebugOpen] = useState<boolean>(false);
  const [lastPayload, setLastPayload] = useState<any>(null);
  const [lastResponse, setLastResponse] = useState<any>(null);

  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const log = React.useCallback(
    (lvl: LogLevel, tag: string, msg: string, meta?: any) => {
      setLogs((prev) => [...prev, { ts: Date.now(), lvl, tag, msg, meta }]);
    },
    []
  );

  useHeaderRefresh(navigation, async () => {
    try {
      setLoading(true);
      log('INFO', 'header', 'refresh pricebook');
      const fresh = await refreshPriceBook();
      setRows(fresh.rows || []);
      setError(null);
      log('INFO', 'pricebook', `loaded ${fresh.rows?.length ?? 0} rows`);
    } catch (e: any) {
      const meta = { message: e?.message, status: e?.status };
      log('ERROR', 'pricebook', 'refresh failed', meta);
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        log('INFO', 'init', 'loading cached pricebook');
        const cached = await loadCachedPriceBook();
        setRows(cached || []);
        log('INFO', 'pricebook', `cached rows: ${cached?.length ?? 0}`);

        log('INFO', 'customers', 'GET /contacts (active)');
        const active = await fetchActiveCustomersWithPriceListMTM();
        setCustomers(active || []);
        log('INFO', 'customers', `loaded ${active?.length ?? 0}`);

        log('INFO', 'sales', 'GET /settings/salespersons');
        const sps = await fetchSalespersonsMTM();
        setSalespersons(sps || []);
        log('INFO', 'sales', `loaded ${sps?.length ?? 0}`);

        setError(null);
      } catch (e: any) {
        const meta = {
          message: e?.message,
          status: e?.status,
          url: e?.url,
          body: e?.body,
        };
        log('ERROR', 'init', 'load failed', meta);
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** Price basis is derived (no UI):
   *    - if customer.cf_price_list === 'Nett' → Nett
   *    - otherwise Ex-mill
   */
  const effectiveBasis: 'Exmill' | 'Nett' =
    selectedCustomer?.priceList === 'Nett' ? 'Nett' : 'Exmill';

  const byItem = useMemo(() => {
    const m: Record<string, NormalizedRow[]> = {};
    for (const r of rows || []) {
      const key = (r.cf_item_name || '').trim();
      if (!key) continue;
      (m[key] ??= []).push(r);
    }
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => {
        const as = `${a.cf_size_1 ?? ''}|${a.cf_packing ?? ''}`;
        const bs = `${b.cf_size_1 ?? ''}|${b.cf_packing ?? ''}`;
        return as.localeCompare(bs);
      });
    }
    return m;
  }, [rows]);

  const itemOptions = () => Object.keys(byItem).sort((a, b) => a.localeCompare(b));
  const variantsFor = (item: string): NormalizedRow[] =>
    !item ? [] : (byItem[item] ?? []).slice();

  const updateLine = (id: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((li) => (li.id === id ? { ...li, ...patch } : li)));

  const rateFrom = (r: NormalizedRow | null | undefined) =>
    effectiveBasis === 'Exmill' ? r?.exmill_rate ?? undefined : r?.nett_rate ?? undefined;

  const selectItemForLine = (id: string, item: string) => {
    setLines((prev) =>
      prev.map((li) => {
        if (li.id !== id) return li;
        const v = variantsFor(item)[0] ?? null;

        return {
          ...li,
          cf_item_name: item,
          cf_size_1: String(v?.cf_size_1 ?? ''),
          cf_packing: String(v?.cf_packing ?? ''),
          qty:
            v?.default_qty != null && Number.isFinite(v.default_qty)
              ? String(v.default_qty)
              : '',
          // Manual override is always allowed: we just prefill from basis.
          rate:
            rateFrom(v) != null && Number.isFinite(rateFrom(v)!)
              ? String(rateFrom(v))
              : '',
        };
      })
    );
  };

  const push3Rows = () =>
    setLines((prev) =>
      prev.concat(
        Array.from({ length: 3 }).map(() => ({
          id: uid(),
          cf_item_name: '',
          cf_size_1: '',
          cf_packing: '',
          qty: '',
          rate: '',
        }))
      )
    );

  const computed = useMemo(() => {
    let subtotal = 0;
    const displayLines = lines.map((li) => {
      const variants = variantsFor(li.cf_item_name);
      const match =
        variants.find(
          (v) =>
            (!li.cf_size_1 || v.cf_size_1 === li.cf_size_1) &&
            (!li.cf_packing || v.cf_packing === li.cf_packing)
        ) || variants[0];

      const qtyNum =
        Number(li.qty !== '' ? li.qty : match?.default_qty ?? 0) || 0;
      const rateNum =
        Number(li.rate !== '' ? li.rate : rateFrom(match) ?? 0) || 0;

      const amount = qtyNum * rateNum;
      subtotal += amount;
      return { ...li, qtyNum, rateNum, amount, match };
    });
    const tax = Math.round(subtotal * 0.05 * 100) / 100;
    const total = subtotal + tax;
    return { displayLines, subtotal, tax, total };
  }, [lines, byItem, effectiveBasis]);

  // When basis or rows change, prefill empty rate cells
  useEffect(() => {
    setLines((prev) =>
      prev.map((li) => {
        if (!li.cf_item_name || li.rate !== '') return li;
        const v = variantsFor(li.cf_item_name)[0];
        const r = rateFrom(v);
        return r != null && Number.isFinite(r) ? { ...li, rate: String(r) } : li;
      })
    );
  }, [effectiveBasis, rows]);

  function buildLineItemsForSend() {
    const diagnostics: Array<{
      cf_item_name: string;
      size: string;
      pack: string;
      zoho_item_name?: string;
      raw_item_id?: any;
      sanitized_item_id: string;
      id_len: number;
      qty: number;
      rate: number;
      valid: boolean;
      reason?: string;
    }> = [];

    const line_items: any[] = [];

    for (const d of computed.displayLines) {
      const v = d.match as NormalizedRow | undefined;
      if (!v) continue;

      const rawId =
        (v as any).zoho_item_id ??
        (v as any)['Item ID'] ??
        (v as any)['item_id'] ??
        (v as any)['ItemId'] ??
        (v as any)['ID'];

      const cleanId = sanitizeItemId(rawId);
      const valid = isValidItemId(cleanId);

      diagnostics.push({
        cf_item_name: v?.cf_item_name ?? '',
        size: v?.cf_size_1 ?? '',
        pack: v?.cf_packing ?? '',
        zoho_item_name: v?.zoho_item_name,
        raw_item_id: rawId,
        sanitized_item_id: cleanId,
        id_len: cleanId.length,
        qty: d.qtyNum,
        rate: d.rateNum,
        valid,
        reason: valid ? undefined : 'Missing/invalid item_id',
      });

      if (d.qtyNum > 0 && Number.isFinite(d.rateNum)) {
        if (!valid) continue;
        line_items.push({
          item_id: cleanId,
          quantity: d.qtyNum,
          rate: d.rateNum,
          tax_percentage: 5,
          item_custom_fields: [
            { api_name: 'cf_item_name', value: v?.cf_item_name ?? '' },
            { api_name: 'cf_size_1', value: v?.cf_size_1 ?? '' },
            { api_name: 'cf_packing', value: v?.cf_packing ?? '' },
          ],
        });
      }
    }

    return { line_items, diagnostics };
  }

  const onCreate = async () => {
    try {
      setLoading(true);
      setLastResponse(null);
      setLastPayload(null);
      if (!selectedCustomer) throw new Error('Pick a customer');
      if (!selectedSalesperson) throw new Error('Pick a sales person');

      const { line_items, diagnostics } = buildLineItemsForSend();

      const invalid = diagnostics.find((d) => d.qty > 0 && !d.valid);
      if (invalid) {
        setLastPayload({ diagnostics, would_send: line_items });
        throw new Error(
          `One or more lines have missing/invalid item_id. Check Debug panel for details.`
        );
      }

      if (!line_items.length) {
        setLastPayload({ diagnostics, would_send: line_items });
        throw new Error('Add at least one valid line with quantity and a valid Item ID.');
      }

      // Build payload
      const custom_fields: any[] = [];
      if (haste && haste.trim().length) {
        custom_fields.push({ api_name: 'cf_haste', value: haste.trim() });
      }

      const payload: any = {
        customer_id: selectedCustomer.id,
        salesperson_id: selectedSalesperson.id, // valid Books salesperson id
        line_items,
        is_inclusive_tax: false,
        custom_fields,
      };

      setLastPayload({ diagnostics, payload });
      log('INFO', 'createSO', 'POST /salesorders', { line_items: line_items.length });

      // Create SO
      const out = await createSalesOrderMTM(payload);
      setLastResponse({ ok: true, response: out });

      const salesorder_id = out?.salesorder_id || out?.salesorder?.salesorder_id;
      const salesorder_number =
        out?.salesorder_number || out?.salesorder?.salesorder_number;

      // Try to fetch PDF and share
      try {
        if (!salesorder_id) throw new Error('Missing salesorder_id in response');
        const filePath = await downloadSalesOrderPdfMTM(String(salesorder_id));
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(filePath, {
            mimeType: 'application/pdf',
            dialogTitle: `Sales Order ${salesorder_number || ''}`,
          });
        }
      } catch (pdfErr: any) {
        log('WARN', 'pdf', 'share failed', { message: pdfErr?.message || String(pdfErr) });
      }

      setError(null);
      // Reset form
      setLines(
        Array.from({ length: 3 }).map(() => ({
          id: uid(),
          cf_item_name: '',
          cf_size_1: '',
          cf_packing: '',
          qty: '',
          rate: '',
        }))
      );
      setHaste('');
      log('INFO', 'createSO', 'success', {
        salesorder_id,
        salesorder_number,
      });
      alert(`Sales Order created: ${salesorder_number || salesorder_id || 'OK'}`);
    } catch (e: any) {
      const meta = { message: e?.message, status: e?.status, body: e?.body };
      log('ERROR', 'createSO', 'failed', meta);
      setLastResponse({ ok: false, error: e?.message || String(e) });
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Item picker */}
      <Portal>
        <Dialog visible={!!pickerOpenFor} onDismiss={() => setPickerOpenFor(null)}>
          <Dialog.Title>Select item</Dialog.Title>
          <Dialog.Content>
            <ScrollView style={{ maxHeight: 360 }}>
              {itemOptions().map((opt) => (
                <Button
                  key={opt}
                  compact
                  onPress={() => {
                    if (pickerOpenFor) selectItemForLine(pickerOpenFor, opt);
                  }}
                >
                  {opt}
                </Button>
              ))}
            </ScrollView>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPickerOpenFor(null)}>Close</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Customer & Sales person pickers */}
      <SearchableListDialog
        title="Select customer"
        visible={customerPickerOpen}
        onClose={() => setCustomerPickerOpen(false)}
        options={customers}
        onPick={(c) => setSelectedCustomer(c)}
      />
      <SearchableListDialog
        title="Select sales person"
        visible={salesPickerOpen}
        onClose={() => setSalesPickerOpen(false)}
        options={salespersons}
        onPick={(s) => setSelectedSalesperson(s)}
      />

      <ScrollView contentContainerStyle={styles.page}>
        {loading && <ActivityIndicator />}
        {error && (
          <HelperText type="error" visible>
            {error}
          </HelperText>
        )}

        <Card>
          <Card.Title
            title="Customer"
            subtitle="Active (MTM)"
            right={() =>
              customers?.length ? (
                <Text style={{ marginRight: 12, opacity: 0.6 }}>
                  {customers.length} contacts
                </Text>
              ) : null
            }
          />
          <Card.Content>
            {selectedCustomer ? (
              <View style={styles.tinyRow}>
                <Chip compact style={styles.chip}>{selectedCustomer.name}</Chip>
                <Button compact onPress={() => setCustomerPickerOpen(true)}>Change</Button>
              </View>
            ) : (
              <Button
                mode="outlined"
                onPress={() => setCustomerPickerOpen(true)}
                icon="account-search"
              >
                Select customer
              </Button>
            )}
            <View style={{ height: 10 }} />

            <Text variant="labelLarge">Sales Person</Text>
            {selectedSalesperson ? (
              <View style={[styles.tinyRow, { marginTop: 6 }]}>
                <Chip compact style={styles.chip}>{selectedSalesperson.name}</Chip>
                <Button compact onPress={() => setSalesPickerOpen(true)}>Change</Button>
              </View>
            ) : (
              <Button mode="outlined" onPress={() => setSalesPickerOpen(true)} icon="account-tie">
                Select sales person
              </Button>
            )}

            <View style={{ height: 10 }} />
            <TextInput
              mode="outlined"
              dense
              label="Haste (cf_haste) — optional"
              value={haste}
              onChangeText={setHaste}
            />

            {/* Price basis row removed — rates auto from customer's cf_price_list; blank ⇒ Ex-mill */}
          </Card.Content>
        </Card>

        <Card>
          <Card.Title
            title="Items"
            right={() => <Button compact onPress={push3Rows}>Add 3 rows</Button>}
          />
          <Card.Content>
            {isCompact ? (
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <Text style={{ flex: 1 }} variant="labelMedium">
                  cf_item_name
                </Text>
              </View>
            ) : (
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <Text style={{ width: styles.itemArea.flexBasis }} variant="labelMedium">
                  cf_item_name
                </Text>
                <Text style={{ width: styles.sizeArea.flexBasis }} variant="labelMedium">
                  Size
                </Text>
                <Text style={{ width: styles.packArea.flexBasis }} variant="labelMedium">
                  Packing
                </Text>
                <Text style={{ width: styles.qtyArea.flexBasis }} variant="labelMedium">
                  Qty
                </Text>
                <Text style={{ width: styles.rateArea.flexBasis }} variant="labelMedium">
                  Rate
                </Text>
              </View>
            )}
            <Divider style={{ marginVertical: 8 }} />

            {lines.map((li) => {
              const hasItem = !!li.cf_item_name;

              if (!isCompact) {
                return (
                  <View key={li.id} style={[styles.row, { alignItems: 'center' }]}>
                    <View style={{ width: styles.itemArea.flexBasis }}>
                      {hasItem ? (
                        <View style={styles.tinyRow}>
                          <Chip
                            compact
                            style={styles.chip}
                            textStyle={chipTextStyle(li.cf_item_name)}
                          >
                            {li.cf_item_name}
                          </Chip>
                          <IconButton icon="pencil" size={18} onPress={() => setPickerOpenFor(li.id)} />
                        </View>
                      ) : (
                        <Button
                          compact
                          mode="outlined"
                          onPress={() => setPickerOpenFor(li.id)}
                          icon="plus"
                        >
                          Select item
                        </Button>
                      )}
                    </View>

                    <View style={{ width: styles.sizeArea.flexBasis }}>
                      <Chip
                        compact
                        style={styles.chip}
                        textStyle={chipTextStyle(li.cf_size_1)}
                      >
                        {li.cf_size_1 || '—'}
                      </Chip>
                    </View>

                    <View style={{ width: styles.packArea.flexBasis }}>
                      <Chip
                        compact
                        style={styles.chip}
                        textStyle={chipTextStyle(li.cf_packing)}
                      >
                        {li.cf_packing || '—'}
                      </Chip>
                    </View>

                    <TextInput
                      style={[styles.compactInput, { width: styles.qtyArea.flexBasis }]}
                      mode="outlined"
                      dense
                      keyboardType="numeric"
                      label="Qty"
                      value={li.qty}
                      onChangeText={(t) => updateLine(li.id, { qty: t })}
                    />
                    <TextInput
                      style={[styles.compactInput, { width: styles.rateArea.flexBasis }]}
                      mode="outlined"
                      dense
                      keyboardType="numeric"
                      label="Rate"
                      value={li.rate}
                      onChangeText={(t) => updateLine(li.id, { rate: t })}
                    />
                  </View>
                );
              }

              // Compact layout
              return (
                <View key={li.id} style={{ marginBottom: 8 }}>
                  <View style={[styles.row, { alignItems: 'center' }]}>
                    <View style={styles.itemFull}>
                      {hasItem ? (
                        <View style={styles.tinyRow}>
                          <Chip
                            compact
                            style={styles.chip}
                            textStyle={chipTextStyle(li.cf_item_name)}
                          >
                            {li.cf_item_name}
                          </Chip>
                          <IconButton icon="pencil" size={18} onPress={() => setPickerOpenFor(li.id)} />
                        </View>
                      ) : (
                        <Button
                          compact
                          mode="outlined"
                          onPress={() => setPickerOpenFor(li.id)}
                          icon="plus"
                        >
                          Select item
                        </Button>
                      )}
                    </View>
                  </View>

                  <View style={[styles.row, { alignItems: 'center', marginTop: 6 }]}>
                    <View style={{ flex: 1 }}>
                      <Chip
                        compact
                        style={styles.chip}
                        textStyle={chipTextStyle(li.cf_size_1)}
                      >
                        {li.cf_size_1 || '—'}
                      </Chip>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Chip
                        compact
                        style={styles.chip}
                        textStyle={chipTextStyle(li.cf_packing)}
                      >
                        {li.cf_packing || '—'}
                      </Chip>
                    </View>
                    <TextInput
                      style={[styles.compactInput, { width: 72 }]}
                      mode="outlined"
                      dense
                      keyboardType="numeric"
                      label="Qty"
                      value={li.qty}
                      onChangeText={(t) => updateLine(li.id, { qty: t })}
                    />
                    <TextInput
                      style={[styles.compactInput, { width: 84 }]}
                      mode="outlined"
                      dense
                      keyboardType="numeric"
                      label="Rate"
                      value={li.rate}
                      onChangeText={(t) => updateLine(li.id, { rate: t })}
                    />
                  </View>
                </View>
              );
            })}
          </Card.Content>
        </Card>

        <Card>
          <Card.Content>
            <Text>Subtotal: ₹ {computed.subtotal.toFixed(2)}</Text>
            <Text>Tax (5%): ₹ {computed.tax.toFixed(2)}</Text>
            <Text variant="titleMedium">Total: ₹ {computed.total.toFixed(2)}</Text>
            <View style={{ height: 8 }} />
            <Button
              mode="contained"
              onPress={onCreate}
              disabled={
                !selectedCustomer ||
                !selectedSalesperson ||
                computed.displayLines.every((d) => d.qtyNum <= 0)
              }
            >
              Create Sale Order & Share PDF
            </Button>
          </Card.Content>
        </Card>

        <Card>
          <Card.Title
            title="Debug"
            subtitle="See exactly what will be sent to Zoho"
            right={() => (
              <View style={[styles.row, { paddingRight: 8 }]}>
                <Text>Show</Text>
                <Switch value={debugOpen} onValueChange={setDebugOpen} />
              </View>
            )}
          />
          {debugOpen && (
            <Card.Content>
              <Text variant="labelLarge">Per-line diagnostics</Text>
              <View style={{ height: 6 }} />
              <View style={{ maxHeight: 220 }}>
                <ScrollView>
                  {computed.displayLines.map((d, i) => {
                    const v = d.match as NormalizedRow | undefined;
                    const rawId =
                      (v as any)?.zoho_item_id ??
                      (v as any)?.['Item ID'] ??
                      (v as any)?.['item_id'] ??
                      (v as any)?.['ItemId'] ??
                      (v as any)?.['ID'];
                    const cleaned = sanitizeItemId(rawId);
                    const ok = isValidItemId(cleaned);
                    return (
                      <View key={i} style={{ marginBottom: 10 }}>
                        <Text style={{ opacity: 0.8 }}>
                          {i + 1}. {v?.cf_item_name} | {v?.cf_size_1} | {v?.cf_packing}
                        </Text>
                        <Text style={{ opacity: 0.8 }}>
                          Zoho Item: {v?.zoho_item_name || '—'}
                        </Text>
                        <Text style={{ opacity: 0.8 }}>
                          Raw Item ID: {String(rawId ?? '—')}
                        </Text>
                        <Text style={{ opacity: 0.8 }}>
                          Sanitized ID: {cleaned || '—'} (len {cleaned.length}) {ok ? '✅' : '❌'}
                        </Text>
                        <Text style={{ opacity: 0.8 }}>
                          Qty={d.qtyNum} Rate={d.rateNum}
                        </Text>
                        <Divider style={{ marginTop: 6 }} />
                      </View>
                    );
                  })}
                </ScrollView>
              </View>

              <View style={{ height: 10 }} />
              <Text variant="labelLarge">Last payload / response</Text>
              <View style={{ height: 6 }} />
              <ScrollView style={{ maxHeight: 280 }}>
                <Text selectable style={styles.monoBox}>
                  {JSON.stringify({ lastPayload, lastResponse }, null, 2)}
                </Text>
              </ScrollView>
            </Card.Content>
          )}
        </Card>

        {/* Collapsible dev console */}
        <DevTerminal
          open={logOpen}
          setOpen={setLogOpen}
          logs={logs}
          onClear={() => setLogs([])}
        />
      </ScrollView>
    </>
  );
}
