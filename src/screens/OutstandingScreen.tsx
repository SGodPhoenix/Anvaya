// src/screens/OutstandingScreen.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView } from 'react-native';
import {
  Text, Card, Divider, IconButton, Portal, Modal,
  Searchbar, Snackbar, Chip, ActivityIndicator
} from 'react-native-paper';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as FSLegacy from 'expo-file-system/legacy';
import { fromByteArray } from 'base64-js';

import {
  ORGS, type OrgKey,
  fetchCustomers,
  fetchOutstandingForOrg,
  type OutstandingCustomerRow
} from '../lib/zoho';
import { generateOutstandingCardPdf } from '../lib/pdf';
import { buildAndShareOutstandingWorkbook } from '../lib/excel';
import { ensureDir, uniqueName } from '../lib/utils';

/* ---------------- helpers ---------------- */

type CustomerLite = { customer_id: string; customer_name: string };

const CACHE_KEYS: Record<OrgKey, string> = {
  PM: 'customers_PM_v1',
  MTM: 'customers_MTM_v1',
  RMD: 'customers_RMD_v1',
  MURLI: 'customers_MURLI_v1',
};
const OUT_CACHE: Record<OrgKey, string> = {
  PM: 'outstanding_PM_v1',
  MTM: 'outstanding_MTM_v1',
  RMD: 'outstanding_RMD_v1',
  MURLI: 'outstanding_MURLI_v1',
};

function firmName(key: OrgKey) {
  const found = ORGS.find(o => o.key === key);
  return found ? found.name : key;
}

function formatINR(n: number) {
  if (!Number.isFinite(n)) n = 0;
  try {
    return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + '/-';
  } catch {
    // Fallback without Intl (older RN)
    const s = (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
    const [intPart, dec] = s.split('.');
    const m = intPart.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,');
    return `${m}.${dec}/-`;
  }
}

/* ---------------- screen ---------------- */

export default function OutstandingScreen() {
  const [selectedOrg, setSelectedOrg] = useState<OrgKey>('PM');

  const [orgModalVisible, setOrgModalVisible] = useState(false);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [custModalVisible, setCustModalVisible] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const [loadingCust, setLoadingCust] = useState(false);

  const [rowsByCustomer, setRowsByCustomer] = useState<Record<string, OutstandingCustomerRow>>({});
  const [isWorking, setIsWorking] = useState(false);
  const [snack, setSnack] = useState({ visible: false, msg: '' });
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<ScrollView>(null);

  const cacheKeyCustomers = useMemo(() => CACHE_KEYS[selectedOrg], [selectedOrg]);
  const cacheKeyOutstanding = useMemo(() => OUT_CACHE[selectedOrg], [selectedOrg]);
  const appendLog = (s: string) =>
    setLog(prev => [...prev, `${new Date().toLocaleTimeString()}  ${s}`]);

  const firmLabel = useMemo(() => firmName(selectedOrg), [selectedOrg]);

  useEffect(() => {
    (async () => {
      setSelectedCustomer('');
      try {
        const cached = await AsyncStorage.getItem(cacheKeyCustomers);
        setCustomers(cached ? (JSON.parse(cached).customers || []) : []);
      } catch {
        setCustomers([]);
      }
      try {
        const cached = await AsyncStorage.getItem(cacheKeyOutstanding);
        setRowsByCustomer(cached ? (JSON.parse(cached) || {}) : {});
      } catch {}
    })();
  }, [cacheKeyCustomers, cacheKeyOutstanding]);

  useEffect(() => {
    const t = setTimeout(() => logRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [log]);

  const filteredCustomers = useMemo(() => {
    const q = custQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(c => (c.customer_name || '').toLowerCase().includes(q));
  }, [customers, custQuery]);

  // Build TOTAL row when nothing is selected (sum over customers)
  const totalRow: OutstandingCustomerRow | null = useMemo(() => {
    const vals = Object.values(rowsByCustomer);
    if (vals.length === 0) return null;
    const base: any = { ...vals[0] };
    for (const k of Object.keys(base)) if (typeof base[k] === 'number') base[k] = 0;
    base.customerName = 'TOTAL';
    base.city = '';
    for (const r of vals) {
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number') base[k] += v;
      }
    }
    return base as OutstandingCustomerRow;
  }, [rowsByCustomer]);

  const currentRow: OutstandingCustomerRow | null =
    selectedCustomer && rowsByCustomer[selectedCustomer]
      ? rowsByCustomer[selectedCustomer]
      : totalRow;

  /* -------- actions -------- */

  const onRefreshAll = async () => {
    setIsWorking(true);
    setLog([]);
    try {
      setLoadingCust(true);
      appendLog(`Fetching customers (${selectedOrg})…`);
      const list = await fetchCustomers(selectedOrg);
      setCustomers(list);
      await AsyncStorage.setItem(
        cacheKeyCustomers,
        JSON.stringify({ customers: list, cachedAt: Date.now() })
      );
      setLoadingCust(false);
      appendLog(`Customers ${list.length}`);

      appendLog(`Fetching outstanding map (${selectedOrg})…`);
      const rowsMap = await fetchOutstandingForOrg(selectedOrg, (s) => appendLog(s));
      setRowsByCustomer(rowsMap);
      await AsyncStorage.setItem(cacheKeyOutstanding, JSON.stringify(rowsMap));

      setSnack({ visible: true, msg: '✅ Data refreshed' });
      appendLog('Done');
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ Refresh failed' });
      appendLog(`❌ ${e?.message || e}`);
      setLoadingCust(false);
    } finally {
      setIsWorking(false);
    }
  };

  const onExcel = async () => {
    try {
      setIsWorking(true);
      setLog([]);
      appendLog('Building workbook…');
      await buildAndShareOutstandingWorkbook((s) => appendLog(s)); // uses your beautified excel builder
      setSnack({ visible: true, msg: '✅ Excel ready' });
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ Excel failed' });
      appendLog(`❌ ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  const onPdf = async () => {
    try {
      if (!currentRow || currentRow.customerName === 'TOTAL') {
        setSnack({ visible: true, msg: 'Pick a customer to export PDF' });
        return;
      }
      setIsWorking(true);
      setLog([]);
      appendLog('Creating PDF…');

      // Exclude the 2 payment rows from the PDF
      const rows = [
        ['0-15', currentRow['0-15']],
        ['16-30', currentRow['16-30']],
        ['31-45', currentRow['31-45']],
        ['46-60', currentRow['46-60']],
        ['61-90', currentRow['61-90']],
        ['91-120', currentRow['91-120']],
        ['121-150', currentRow['121-150']],
        ['151-180', currentRow['151-180']],
        ['Above 180', currentRow['Above_180']],
        ['Total', currentRow['Total']],
        ['CN', currentRow['CN']],
        ['Payment', currentRow['Payment']],
        ['Balance', currentRow['Balance']],
      ].map(([label, val]) => ({ label: String(label), value: formatINR(Number(val || 0)) }));

      const bytes = await generateOutstandingCardPdf({
        title: 'Outstanding',
        org: firmLabel,
        customer: currentRow.customerName,
        rows,
      });

      const base64 = fromByteArray(bytes);
      const safe = currentRow.customerName.replace(/[\\/:*?"<>|]/g, '_');
      const name = `Outstanding_${safe}_${uniqueName()}.pdf`;

      const baseDir = FSLegacy.documentDirectory || FSLegacy.cacheDirectory;
      if (!baseDir) throw new Error('No writable directory');
      const outDir = baseDir + 'Anvaya/';
      await ensureDir(outDir);
      const uri = outDir + name;

      await FSLegacy.writeAsStringAsync(uri, base64, { encoding: FSLegacy.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
      setSnack({ visible: true, msg: '✅ PDF ready' });
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ PDF failed' });
      appendLog(`❌ ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  /* -------- derived UI rows -------- */

  const moneyRows = currentRow ? ([
    ['0-15', currentRow['0-15']],
    ['16-30', currentRow['16-30']],
    ['31-45', currentRow['31-45']],
    ['46-60', currentRow['46-60']],
    ['61-90', currentRow['61-90']],
    ['91-120', currentRow['91-120']],
    ['121-150', currentRow['121-150']],
    ['151-180', currentRow['151-180']],
    ['Above 180', currentRow['Above_180']],
    ['Total', currentRow['Total']],
    ['CN', currentRow['CN']],
    ['Payment', currentRow['Payment']],
    ['Balance', currentRow['Balance']],
  ] as const) : [];

  const paymentsBox = (selectedCustomer && currentRow && currentRow.customerName !== 'TOTAL') ? ([
    ['0-15 Payments', currentRow['0-15_payments']],
    ['16-90 Payments', currentRow['16-90_payments']],
  ] as const) : [];

  /* ---------------- render ---------------- */

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
      <Card style={{ borderRadius: 16, overflow: 'hidden' }}>
        <Card.Title
          title="📒 Outstanding"
          subtitle="Select firm → Refresh → choose a customer"
          right={(props) => (
            <View style={{ flexDirection: 'row' }}>
              <IconButton
                {...props}
                icon="microsoft-excel"
                onPress={onExcel}
                accessibilityLabel="Download Excel"
              />
              <IconButton
                {...props}
                icon={isWorking ? 'progress-clock' : 'refresh'}
                onPress={onRefreshAll}
                disabled={isWorking}
              />
            </View>
          )}
        />
        <Divider />
        <Card.Content>
          {/* Firm row */}
          <Text style={{ marginTop: 8, marginBottom: 6 }}>Firm</Text>
          <Chip
            icon="office-building"
            selected
            onPress={() => setOrgModalVisible(true)}
            style={{ alignSelf: 'flex-start' }}
          >
            {firmLabel}
          </Chip>

          {/* Customer row with PDF icon on right */}
          <Text style={{ marginTop: 16, marginBottom: 6 }}>Customer</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Chip
              icon="account"
              onPress={() => setCustModalVisible(true)}
              style={{ alignSelf: 'flex-start' }}
            >
              {selectedCustomer || 'TOTAL (All)'}
            </Chip>
            <IconButton
              icon="file-pdf-box"
              onPress={onPdf}
              disabled={!selectedCustomer || !rowsByCustomer[selectedCustomer] || isWorking}
            />
          </View>

          {/* Values card */}
          <View style={{ marginTop: 16 }}>
            {!currentRow ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator />
                <Text>Load data with Refresh.</Text>
              </View>
            ) : (
              <>
                <Card style={{ borderRadius: 12, marginBottom: 12 }}>
                  <Card.Title
                    title={currentRow.customerName === 'TOTAL'
                      ? `${firmLabel} — TOTAL`
                      : currentRow.customerName}
                    subtitle={currentRow.customerName === 'TOTAL' ? '' : firmLabel}
                  />
                  <Divider />
                  <Card.Content>
                    {moneyRows.map(([label, val]) => (
                      <View
                        key={label}
                        style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 }}
                      >
                        <Text variant="labelLarge">{label}</Text>
                        <Text style={{ fontWeight: 'bold' }}>{formatINR(Number(val || 0))}</Text>
                      </View>
                    ))}
                  </Card.Content>
                </Card>

                {paymentsBox.length > 0 && (
                  <Card style={{ borderRadius: 12 }}>
                    <Card.Title title="Payments (by payment date)" />
                    <Divider />
                    <Card.Content>
                      {paymentsBox.map(([label, val]) => (
                        <View
                          key={label}
                          style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 }}
                        >
                          <Text variant="labelLarge">{label}</Text>
                          <Text style={{ fontWeight: 'bold' }}>{formatINR(Number(val || 0))}</Text>
                        </View>
                      ))}
                    </Card.Content>
                  </Card>
                )}
              </>
            )}
          </View>
        </Card.Content>
      </Card>

      {/* Activity */}
      <Card style={{ marginTop: 16, borderRadius: 16, marginBottom: 20 }}>
        <Card.Title title="📡 Activity" subtitle="Live log" />
        <Divider />
        <Card.Content>
          {log.length === 0 ? (
            <Text>Idle.</Text>
          ) : (
            <View style={{ height: 180 }}>
              <ScrollView ref={logRef}>
                {log.map((line, idx) => (
                  <Text key={`${idx}-${line}`} style={{ marginBottom: 4 }}>
                    {line}
                  </Text>
                ))}
              </ScrollView>
            </View>
          )}
        </Card.Content>
      </Card>

      {/* Modals */}
      <Portal>
        {/* Firm modal */}
        <Modal
          visible={orgModalVisible}
          onDismiss={() => setOrgModalVisible(false)}
          contentContainerStyle={{
            backgroundColor: 'white',
            margin: 16,
            borderRadius: 12,
            padding: 12
          }}
        >
          <Text variant="titleMedium" style={{ marginBottom: 8 }}>Select Firm</Text>
          {ORGS.map((o) => (
            <Chip
              key={o.key}
              style={{ marginBottom: 8, alignSelf: 'flex-start' }}
              selected={o.key === selectedOrg}
              onPress={() => {
                setSelectedOrg(o.key);
                setSelectedCustomer('');
                setOrgModalVisible(false);
              }}
            >
              {o.name}
            </Chip>
          ))}
        </Modal>

        {/* Customer modal */}
        <Modal
          visible={custModalVisible}
          onDismiss={() => setCustModalVisible(false)}
          contentContainerStyle={{
            backgroundColor: 'white',
            margin: 16,
            borderRadius: 12,
            padding: 12,
            maxHeight: '80%'
          }}
        >
          <Text variant="titleMedium">Pick Customer</Text>
          <Searchbar
            placeholder="Search…"
            value={custQuery}
            onChangeText={setCustQuery}
            style={{ marginTop: 8, marginBottom: 8 }}
          />
          <ScrollView style={{ maxHeight: 420 }}>
            {filteredCustomers.map((c) => (
              <Chip
                key={c.customer_id}
                style={{ marginBottom: 8, alignSelf: 'flex-start' }}
                onPress={() => {
                  setSelectedCustomer(c.customer_name);
                  setCustModalVisible(false);
                }}
              >
                {c.customer_name}
              </Chip>
            ))}
          </ScrollView>
        </Modal>
      </Portal>

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
