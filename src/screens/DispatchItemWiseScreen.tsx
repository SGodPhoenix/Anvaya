// src/screens/DispatchItemWiseScreen.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Platform, ScrollView, Linking } from 'react-native';
import {
  Text, Button, Card, Divider, IconButton, ActivityIndicator,
  Portal, Modal, Searchbar, Snackbar, Chip, Checkbox,
} from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as FS from 'expo-file-system';
import * as FSLegacy from 'expo-file-system/legacy';
import { fromByteArray } from 'base64-js';

import { fetchCustomers, fetchDispatchItemWise, type OrgKey } from '../lib/zoho';
import { generateDispatchItemWisePdf } from '../lib/pdf';
import { ensureDir } from '../lib/utils';

type CustomerRow = { customer_id: string; customer_name: string };

const CACHE_KEY = (org: OrgKey) => `customers_${org}_v1`;

export default function DispatchItemWiseScreen() {
  // --- Firm selection
  const [orgKey, setOrgKey] = useState<OrgKey>('MTM');

  // --- Customer & dates
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const [fromDate, setFromDate] = useState(new Date());
  const [toDate, setToDate] = useState(new Date());
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);

  // --- Single LR Details checkbox
  const [includeLRDetails, setIncludeLRDetails] = useState(false);

  // --- Customers modal & cache
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [custModalVisible, setCustModalVisible] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [loadingCust, setLoadingCust] = useState(false);

  // --- Activity UI
  const [snack, setSnack] = useState({ visible: false, msg: '' });
  const [isWorking, setIsWorking] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<ScrollView>(null);

  // Helpers --------------------------------------------------------
  const appendLog = (s: string) =>
    setLog(prev => [...prev, `${new Date().toLocaleTimeString()}  ${s}`]);

  const formatDateIso = (d: Date) => {
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, '0');
    const da = String(dd.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  };

  const toDDMMYY = (d: Date) => {
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const yr = String(d.getFullYear()).slice(-2);
    return `${day}/${mon}/${yr}`;
  };

  const toFileDate = (d: Date) => {
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const yr = String(d.getFullYear()).slice(-2);
    return `${day}${mon}${yr}`;
  };

  // Load cached customers when org changes
  useEffect(() => {
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY(orgKey));
        if (cached) {
          const j = JSON.parse(cached);
          setCustomers(Array.isArray(j.customers) ? j.customers : []);
        } else {
          setCustomers([]);
        }
      } catch {
        setCustomers([]);
      }
      setSelectedCustomer('');
    })();
  }, [orgKey]);

  useEffect(() => {
    const t = setTimeout(() => logRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [log]);

  const filteredCustomers = useMemo(() => {
    const q = custQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(c => (c.customer_name || '').toLowerCase().includes(q));
  }, [customers, custQuery]);

  const refreshCustomers = async () => {
    try {
      setLoadingCust(true);
      appendLog(`Fetching customers for ${orgKey}...`);
      const list = await fetchCustomers(orgKey);
      setCustomers(list);
      await AsyncStorage.setItem(CACHE_KEY(orgKey), JSON.stringify({ customers: list, cachedAt: Date.now() }));
      setSnack({ visible: true, msg: `Fetched ${list.length} customers` });
      appendLog(`Loaded ${list.length} customers for ${orgKey} (cached).`);
    } catch (e: any) {
      setSnack({ visible: true, msg: 'Failed to fetch customers' });
      appendLog(`X Failed to fetch customers: ${e?.message || e}`);
    } finally {
      setLoadingCust(false);
    }
  };

  const openFile = async (uri: string) => {
    appendLog(`Opening -> ${uri}`);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
    else Linking.openURL(uri);
  };

  const onGenerate = async () => {
    setIsWorking(true);
    setLog([]);

    try {
      const payload = {
        customer: selectedCustomer,
        from: formatDateIso(fromDate),
        to: formatDateIso(toDate),
      };

      appendLog(`Loading item-wise rows -> [${orgKey}] ${payload.customer} (${payload.from} to ${payload.to})`);
      const groups = await fetchDispatchItemWise(orgKey, payload, appendLog);
      const itemCount = groups.reduce((a, g) => a + g.items.length, 0);
      appendLog(`Fetched ${groups.length} invoices (expanded to ${itemCount} items)`);

      const heading = `${payload.customer} - ${toDDMMYY(fromDate)} to ${toDDMMYY(toDate)}`;

      const bytes = await generateDispatchItemWisePdf({
        heading,
        groups,
        org: orgKey,
        showLRDetails: includeLRDetails,
      });

      const safeCustomer = payload.customer.replace(/[\/\\]/g, '_').replace(/\s+/g, '_');
      const range =
        payload.from === payload.to
          ? toFileDate(fromDate)
          : `${toFileDate(fromDate)}_${toFileDate(toDate)}`;
      const fileName = `${range}_${orgKey}_${safeCustomer}_DispatchItemWise.pdf`;

      const base64 = fromByteArray(bytes);
      const trySave = async (base: string | null | undefined) => {
        if (!base) return null;
        const dir = base + 'Anvaya/';
        await ensureDir(dir);
        const uri = dir + fileName;
        await FSLegacy.writeAsStringAsync(uri, base64, { encoding: FSLegacy.EncodingType.Base64 });
        return uri;
      };

      let fileUri = await trySave(FSLegacy.documentDirectory);
      if (!fileUri) fileUri = await trySave(FSLegacy.cacheDirectory);

      if (!fileUri && (FS as any).StorageAccessFramework && Platform.OS === 'android') {
        appendLog('Requesting SAF permission...');
        const perm = await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (perm.granted) {
          const created = await FS.StorageAccessFramework.createFileAsync(perm.directoryUri, fileName, 'application/pdf');
          await FS.writeAsStringAsync(created, base64, { encoding: FS.EncodingType.Base64 });
          fileUri = created;
        }
      }

      if (!fileUri) throw new Error('No writable directory available');

      appendLog(`Saved -> ${fileUri}`);
      setSnack({ visible: true, msg: 'Item-wise Dispatch PDF ready — sharing...' });
      await openFile(fileUri);
    } catch (e: any) {
      setSnack({ visible: true, msg: 'Error generating PDF' });
      appendLog(`X Error: ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  // Chip label helper to mirror "Dispatch" screen naming
  const orgLabel = (k: OrgKey) =>
    k === 'PM' ? 'Pashupati Marketing' :
    k === 'MURLI' ? 'MURLI' :
    k;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
      <Card style={{ borderRadius: 16, overflow: 'hidden' }}>
        <Card.Title
          title="🧾 Dispatch Item Wise"
          subtitle="Select firm, customer, date range and options"
          right={(props) => (
            <IconButton
              {...props}
              icon={loadingCust ? 'progress-download' : 'refresh'}
              onPress={refreshCustomers}
              disabled={loadingCust}
              accessibilityLabel="Refresh customers"
            />
          )}
        />
        <Divider />
        <Card.Content>
          {/* Firm selector - styled like Dispatch screen */}
          <Text style={{ marginTop: 8, marginBottom: 6 }}>Organisation</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {(['PM', 'MTM', 'RMD', 'MURLI'] as OrgKey[]).map(k => {
              const selected = orgKey === k;
              return (
                <Chip
                  key={k}
                  icon="office-building"
                  selected={selected}
                  onPress={() => setOrgKey(k)}
                  style={{
                    marginRight: 8,
                    marginBottom: 8,
                    // give a subtle filled look when selected (matches Dispatch vibe)
                    backgroundColor: selected ? 'rgba(99,102,241,0.15)' : undefined,
                  }}
                  textStyle={{ fontWeight: selected ? '700' : '500' }}
                >
                  {orgLabel(k)}
                </Chip>
              );
            })}
          </View>

          {/* Customer picker */}
          <Text style={{ marginTop: 16, marginBottom: 6 }}>Customer</Text>
          <Button
            mode="outlined"
            onPress={() => {
              if (customers.length === 0 && !loadingCust) refreshCustomers();
              setCustModalVisible(true);
            }}
          >
            {selectedCustomer || 'Select Customer'}
          </Button>

          <Portal>
            <Modal
              visible={custModalVisible}
              onDismiss={() => setCustModalVisible(false)}
              contentContainerStyle={{ backgroundColor: 'white', margin: 16, borderRadius: 12, padding: 12, maxHeight: '80%' }}
            >
              <Text variant="titleMedium" style={{ marginBottom: 8 }}>
                Select Customer ({orgKey})
              </Text>
              <Searchbar
                placeholder="Search customers..."
                value={custQuery}
                onChangeText={setCustQuery}
                style={{ marginBottom: 8 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {customers.length === 0 ? (
                <View style={{ alignItems: 'center', padding: 24 }}>
                  {loadingCust ? <ActivityIndicator /> : <Text>Tap refresh (top-right) to download customers</Text>}
                </View>
              ) : (
                <View style={{ maxHeight: '65%' }}>
                  <ScrollView keyboardShouldPersistTaps="handled">
                    {filteredCustomers.map(item => (
                      <Button
                        key={item.customer_id}
                        mode="text"
                        onPress={() => { setSelectedCustomer(item.customer_name); setCustModalVisible(false); setCustQuery(''); }}
                        style={{ justifyContent: 'flex-start' }}
                      >
                        {item.customer_name}
                      </Button>
                    ))}
                  </ScrollView>
                </View>
              )}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Button onPress={() => setCustQuery('')} icon="close">Clear</Button>
                <Button onPress={() => setCustModalVisible(false)}>Close</Button>
              </View>
            </Modal>
          </Portal>

          {/* Dates (DD/MM/YY) */}
          <Text style={{ marginTop: 16, marginBottom: 6 }}>From Date</Text>
          <Button mode="outlined" onPress={() => setShowFromPicker(true)}>{toDDMMYY(fromDate)}</Button>
          {showFromPicker && (
            <DateTimePicker
              value={fromDate} mode="date" display="calendar"
              onChange={(e, d) => { if (Platform.OS === 'android') setShowFromPicker(false); if (d) setFromDate(d); }}
            />
          )}

          <Text style={{ marginTop: 16, marginBottom: 6 }}>To Date</Text>
          <Button mode="outlined" onPress={() => setShowToPicker(true)}>{toDDMMYY(toDate)}</Button>
          {showToPicker && (
            <DateTimePicker
              value={toDate} mode="date" display="calendar"
              onChange={(e, d) => { if (Platform.OS === 'android') setShowToPicker(false); if (d) setToDate(d); }}
            />
          )}

          {/* Single checkbox */}
          <View style={{ marginTop: 16 }}>
            <Text variant="titleMedium" style={{ marginBottom: 8 }}>Include in PDF</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Checkbox status={includeLRDetails ? 'checked' : 'unchecked'} onPress={() => setIncludeLRDetails(v => !v)} />
              <Text>LR Details (LR No + LR Date + Transport)</Text>
            </View>
          </View>

          <Button
            mode="contained"
            onPress={onGenerate}
            style={{ marginTop: 18, paddingVertical: 6, borderRadius: 10 }}
            disabled={!selectedCustomer || isWorking}
          >
            📄 Generate Item-wise PDF
          </Button>
        </Card.Content>
      </Card>

      {/* Activity */}
      <Card style={{ marginTop: 16, borderRadius: 16, marginBottom: 20 }}>
        <Card.Title title="📡 Activity" subtitle="Live log" right={() => (isWorking ? <ActivityIndicator style={{ marginRight: 16 }} /> : null)} />
        <Divider />
        <Card.Content>
          {log.length === 0 ? (
            <Text>Idle.</Text>
          ) : (
            <View style={{ height: 220 }}>
              <ScrollView ref={logRef}>
                {log.map((line, idx) => (<Text key={`${idx}-${line}`} style={{ marginBottom: 4 }}>{line}</Text>))}
              </ScrollView>
            </View>
          )}
        </Card.Content>
      </Card>

      <Snackbar visible={snack.visible} onDismiss={() => setSnack({ visible: false, msg: '' })} duration={2500}>
        {snack.msg}
      </Snackbar>
    </ScrollView>
  );
}
