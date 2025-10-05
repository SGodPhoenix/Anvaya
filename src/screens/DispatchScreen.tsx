import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Platform, ScrollView, Linking } from 'react-native';
import {
  Text, Button, Card, Divider, IconButton, ActivityIndicator,
  Portal, Modal, Searchbar, Snackbar, Chip, Checkbox
} from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as FS from 'expo-file-system';
import * as FSLegacy from 'expo-file-system/legacy';

import { ORGS, type OrgKey, fetchCustomers, fetchDispatchRows } from '../lib/zoho';
import { generateDispatchPdf } from '../lib/pdf';
import { fromByteArray } from 'base64-js';
import { ensureDir, uniqueName } from '../lib/utils';

const CACHE_KEYS: Record<OrgKey, string> = {
  PM: 'customers_PM_v1',
  MTM: 'customers_MTM_v1',
  RMD: 'customers_RMD_v1',
  MURLI: 'customers_MURLI_v1',
};

export default function DispatchScreen() {
  const [selectedOrg, setSelectedOrg] = useState<OrgKey>('PM');
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const [fromDate, setFromDate] = useState(new Date());
  const [toDate, setToDate] = useState(new Date());
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);

  const [includeLRDate, setIncludeLRDate] = useState(true);
  const [includeTransport, setIncludeTransport] = useState(true);

  const [customers, setCustomers] = useState<{ customer_id: string; customer_name: string }[]>([]);
  const [custModalVisible, setCustModalVisible] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [loadingCust, setLoadingCust] = useState(false);
  const [orgModalVisible, setOrgModalVisible] = useState(false);

  const [snack, setSnack] = useState({ visible:false, msg:'' });
  const [log, setLog] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const logRef = useRef<ScrollView>(null);

  const cacheKey = useMemo(() => CACHE_KEYS[selectedOrg], [selectedOrg]);
  const appendLog = (s: string) => setLog(prev => [...prev, `${new Date().toLocaleTimeString()}  ${s}`]);
  const formatDateIso = (d: Date) => d.toISOString().split('T')[0];

  useEffect(() => {
    (async () => {
      setSelectedCustomer('');
      try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) setCustomers(JSON.parse(cached).customers || []);
        else setCustomers([]);
      } catch { setCustomers([]); }
    })();
  }, [cacheKey]);

  useEffect(() => {
    const t = setTimeout(() => logRef.current?.scrollToEnd({ animated:true }), 50);
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
      appendLog(`Fetching customers for ${selectedOrg}…`);
      const list = await fetchCustomers(selectedOrg);
      setCustomers(list);
      await AsyncStorage.setItem(cacheKey, JSON.stringify({ customers: list, cachedAt: Date.now() }));
      setSnack({ visible: true, msg: `Fetched ${list.length} customers` });
      appendLog(`Loaded ${list.length} customers for ${selectedOrg} (cached).`);
    } catch (e: any) {
      setSnack({ visible: true, msg: `Failed to fetch customers` });
      appendLog(`❌ Failed to fetch customers: ${e?.message || e}`);
    } finally {
      setLoadingCust(false);
    }
  };

  const openFile = async (uri: string) => {
    appendLog(`Opening → ${uri}`);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri);
    } else {
      Linking.openURL(uri);
    }
  };

  const onGenerate = async () => {
    setIsWorking(true); setLog([]);
    try {
      const payload = {
        org: selectedOrg,
        customer: selectedCustomer,
        from: formatDateIso(fromDate),
        to: formatDateIso(toDate),
      };
      appendLog(`Loading dispatch rows → [${payload.org}] ${payload.customer} (${payload.from} → ${payload.to})`);

      const rows = await fetchDispatchRows(payload, appendLog);
      appendLog(`Fetched ${rows.length} rows`);

      const heading = `${payload.customer} — ${payload.from} → ${payload.to}`;
      const bytes = await generateDispatchPdf({
        heading,
        rows,
        showLRDate: includeLRDate,
        showTransport: includeTransport,
      });

      const base64 = fromByteArray(bytes);
      const safeCustomer = payload.customer.replace(/[\/\\]/g, '_').replace(/\s+/g, '_');
      const fileName = `${uniqueName()}_${payload.org}_${safeCustomer}_Dispatch.pdf`;

      // Save with legacy paths first (works in Expo Go), fall back to SAF
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
        appendLog('Requesting SAF permission…');
        const perm = await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (perm.granted) {
          fileUri = await FS.StorageAccessFramework.createFileAsync(
            perm.directoryUri,
            fileName,
            'application/pdf'
          );
          await FS.writeAsStringAsync(fileUri, base64, { encoding: FS.EncodingType.Base64 });
        }
      }

      if (!fileUri) throw new Error('No writable directory available');

      appendLog(`Saved → ${fileUri}`);
      setSnack({ visible: true, msg: '✅ Dispatch PDF ready — sharing…' });
      await openFile(fileUri);
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ Error' });
      appendLog(`❌ Error: ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:12 }}>
      {/* Filters */}
      <Card style={{ borderRadius:16, overflow:'hidden' }}>
        <Card.Title
          title="🚚 Dispatch Details"
          subtitle="Select org, customer, date range and options"
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
          {/* Org selector */}
          <Text style={{ marginTop: 8, marginBottom: 6 }}>Organisation</Text>
          <View style={{ flexDirection:'row', flexWrap:'wrap' }}>
            <Chip icon="office-building" selected onPress={() => setOrgModalVisible(true)} style={{ alignSelf:'flex-start' }}>
              {ORGS.find(o => o.key === selectedOrg)?.name || selectedOrg}
            </Chip>
          </View>

          {/* ORG modal */}
          <Portal>
            <Modal
              visible={orgModalVisible}
              onDismiss={() => setOrgModalVisible(false)}
              contentContainerStyle={{ backgroundColor:'white', margin:16, borderRadius:12, padding:12, maxHeight:'70%' }}
            >
              <Text variant="titleMedium" style={{ marginBottom:8 }}>Select Organisation</Text>
              {ORGS.map(o => (
                <Button
                  key={o.key}
                  mode={o.key === selectedOrg ? 'contained' : 'outlined'}
                  style={{ marginBottom:8 }}
                  onPress={() => { setSelectedOrg(o.key as OrgKey); setOrgModalVisible(false); }}
                >
                  {o.name}
                </Button>
              ))}
              <View style={{ flexDirection:'row', justifyContent:'flex-end' }}>
                <Button onPress={() => setOrgModalVisible(false)}>Close</Button>
              </View>
            </Modal>
          </Portal>

          {/* Customer picker */}
          <Text style={{ marginTop: 16, marginBottom: 6 }}>Customer</Text>
          <Button mode="outlined" onPress={() => setCustModalVisible(true)}>
            {selectedCustomer || 'Select Customer'}
          </Button>

          {/* CUSTOMER modal */}
          <Portal>
            <Modal
              visible={custModalVisible}
              onDismiss={() => setCustModalVisible(false)}
              contentContainerStyle={{ backgroundColor:'white', margin:16, borderRadius:12, padding:12, maxHeight:'80%' }}
            >
              <Text variant="titleMedium" style={{ marginBottom: 8 }}>
                Select Customer ({ORGS.find(o => o.key === selectedOrg)?.name})
              </Text>
              <Searchbar
                placeholder="Search customers…"
                value={custQuery}
                onChangeText={setCustQuery}
                style={{ marginBottom:8 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {customers.length === 0 ? (
                <View style={{ alignItems:'center', padding:24 }}>
                  {loadingCust ? <ActivityIndicator /> : <Text>Tap refresh (top-right) to download customers</Text>}
                </View>
              ) : (
                <View style={{ maxHeight:'65%' }}>
                  <ScrollView keyboardShouldPersistTaps="handled">
                    {filteredCustomers.map(item => (
                      <Button
                        key={item.customer_id}
                        mode="text"
                        onPress={() => { setSelectedCustomer(item.customer_name); setCustModalVisible(false); setCustQuery(''); }}
                        style={{ justifyContent:'flex-start' }}
                      >
                        {item.customer_name}
                      </Button>
                    ))}
                  </ScrollView>
                </View>
              )}
              <View style={{ flexDirection:'row', justifyContent:'space-between', marginTop:8 }}>
                <Button onPress={() => setCustQuery('')} icon="close">Clear</Button>
                <Button onPress={() => setCustModalVisible(false)}>Close</Button>
              </View>
            </Modal>
          </Portal>

          {/* Dates */}
          <Text style={{ marginTop:16, marginBottom:6 }}>From Date</Text>
          <Button mode="outlined" onPress={() => setShowFromPicker(true)}>{fromDate.toDateString()}</Button>
          {showFromPicker && (
            <DateTimePicker
              value={fromDate}
              mode="date"
              display="calendar"
              onChange={(e, d) => { setShowFromPicker(Platform.OS === 'ios'); if (d) setFromDate(d); if (Platform.OS === 'android') setShowFromPicker(false); }}
            />
          )}
          <Text style={{ marginTop:16, marginBottom:6 }}>To Date</Text>
          <Button mode="outlined" onPress={() => setShowToPicker(true)}>{toDate.toDateString()}</Button>
          {showToPicker && (
            <DateTimePicker
              value={toDate}
              mode="date"
              display="calendar"
              onChange={(e, d) => { setShowToPicker(Platform.OS === 'ios'); if (d) setToDate(d); if (Platform.OS === 'android') setShowToPicker(false); }}
            />
          )}

          {/* Options */}
          <View style={{ marginTop:16 }}>
            <Text variant="titleMedium" style={{ marginBottom:8 }}>Include in PDF</Text>
            <View style={{ flexDirection:'row', alignItems:'center', marginBottom:6 }}>
              <Checkbox status={includeLRDate ? 'checked' : 'unchecked'} onPress={() => setIncludeLRDate(v => !v)} />
              <Text>LR Date (cf_lr_date)</Text>
            </View>
            <View style={{ flexDirection:'row', alignItems:'center' }}>
              <Checkbox status={includeTransport ? 'checked' : 'unchecked'} onPress={() => setIncludeTransport(v => !v)} />
              <Text>Transport (cf_transport_name)</Text>
            </View>
          </View>

          <Button
            mode="contained"
            onPress={onGenerate}
            style={{ marginTop:18, paddingVertical:6, borderRadius:10 }}
            disabled={!selectedCustomer || isWorking}
          >
            📄 Generate Dispatch PDF
          </Button>
        </Card.Content>
      </Card>

      {/* Activity */}
      <Card style={{ marginTop:16, borderRadius:16, marginBottom:20 }}>
        <Card.Title title="📡 Activity" subtitle="Live log" right={() => (isWorking ? <ActivityIndicator style={{ marginRight:16 }} /> : null)} />
        <Divider />
        <Card.Content>
          {log.length === 0 ? <Text>Idle.</Text> : (
            <View style={{ height: 220 }}>
              <ScrollView ref={logRef}>
                {log.map((line, idx) => (
                  <Text key={`${idx}-${line}`} style={{ marginBottom:4 }}>{line}</Text>
                ))}
              </ScrollView>
            </View>
          )}
        </Card.Content>
      </Card>

      <Snackbar visible={snack.visible} onDismiss={() => setSnack({ visible:false, msg:'' })} duration={2500}>
        {snack.msg}
      </Snackbar>
    </ScrollView>
  );
}
