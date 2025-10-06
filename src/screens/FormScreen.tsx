// src/screens/FormScreen.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Platform, Linking, ScrollView } from 'react-native';
import {
  Text,
  Button,
  Card,
  Divider,
  IconButton,
  ActivityIndicator,
  Portal,
  Modal,
  Searchbar,
  Snackbar,
  Chip,
} from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as FS from 'expo-file-system/legacy';

import { fetchCustomers, fetchInvoicesAndMerge, ORGS, type OrgKey } from '../lib/zoho';
import { getHistory, pushHistory, type HistoryItem } from '../lib/history';

const CACHE_KEYS: Record<OrgKey, string> = {
  PM: 'customers_PM_v1',
  MTM: 'customers_MTM_v1',
  RMD: 'customers_RMD_v1',
  MURLI: 'customers_MURLI_v1',
};

const QUICK_JOBS = {
  DS: [
    { org: 'PM' as OrgKey,  customer: 'SHREE DHOLI SATI TEXTILE PVT LTD JN' },
    { org: 'MTM' as OrgKey, customer: 'Shree Dholi Sati Textile Pvt Ltd'   },
  ],
};

export default function FormScreen() {
  // ---------------- state ----------------
  const [selectedOrg, setSelectedOrg] = useState<OrgKey>('PM');
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');

  const [fromDate, setFromDate] = useState(new Date());
  const [toDate, setToDate] = useState(new Date());
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);

  const [customers, setCustomers] = useState<{ customer_id: string; customer_name: string }[]>([]);
  const [custModalVisible, setCustModalVisible] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [loadingCust, setLoadingCust] = useState(false);

  const [orgModalVisible, setOrgModalVisible] = useState(false);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);

  const [snack, setSnack] = useState({ visible: false, msg: '' });

  const logRef = useRef<ScrollView>(null);
  const cacheKey = useMemo(() => CACHE_KEYS[selectedOrg], [selectedOrg]);

  // ---------------- effects ----------------
  useEffect(() => {
    (async () => {
      setSelectedCustomer('');
      try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          setCustomers(parsed.customers || []);
        } else {
          setCustomers([]);
        }
      } catch {
        setCustomers([]);
      }
    })();
  }, [cacheKey]);

  useEffect(() => {
    (async () => {
      setHistory(await getHistory());
    })();
  }, []);

  // auto-scroll activity to bottom
  useEffect(() => {
    const t = setTimeout(() => logRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [log]);

  // ---------------- helpers ----------------
  const appendLog = (line: string) =>
    setLog((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${line}`]);

  const filteredCustomers = useMemo(() => {
    const q = custQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => (c.customer_name || '').toLowerCase().includes(q));
  }, [customers, custQuery]);

  // ✅ IST-safe YYYY-MM-DD (Asia/Kolkata), independent of device timezone
  const formatDateIso = (d: Date) => {
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000; // convert local -> UTC
    const ist = new Date(utcMs + 330 * 60000); // add +5:30h
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const day = String(ist.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const getYesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return startOfDay(d);
  };

  // ----- File naming helpers -----
  const isoToDDMMYY = (iso: string) => {
    // iso: "YYYY-MM-DD" -> "DDMMYY"
    const [y, m, d] = iso.split('-');
    return `${d}${m}${y.slice(-2)}`;
  };

  const safeFilename = (s: string) =>
    s.replace(/[\/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();

  const getDirFromUri = (uri: string) => uri.slice(0, uri.lastIndexOf('/') + 1);
  const getNameFromUri = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

  const uniquePath = async (dir: string, baseName: string, ext = '.pdf') => {
    let path = `${dir}${baseName}${ext}`;
    let i = 2;
    while ((await FS.getInfoAsync(path)).exists) {
      path = `${dir}${baseName} (${i})${ext}`;
      i++;
    }
    return path;
  };

  const makeDesiredBaseName = (org: OrgKey, customer: string, fromIso: string, toIso: string) => {
    const d1 = isoToDDMMYY(fromIso);
    const d2 = isoToDDMMYY(toIso);
    const firm = org; // org already PM/MTM/RMD/MURLI
    const cust = safeFilename(customer);
    return d1 === d2 ? `${d1}_${firm}_${cust}` : `${d1}_${d2}_${firm}_${cust}`;
  };

  const renameMerged = async (
    currentUri: string,
    org: OrgKey,
    customer: string,
    fromIso: string,
    toIso: string
  ) => {
    const dir = getDirFromUri(currentUri);
    const desiredBase = makeDesiredBaseName(org, customer, fromIso, toIso);
    const currentName = getNameFromUri(currentUri);
    const desiredName = `${desiredBase}.pdf`;

    if (currentName === desiredName) {
      return { uri: currentUri, name: desiredName };
    }

    const targetUri = await uniquePath(dir, desiredBase, '.pdf');
    await FS.moveAsync({ from: currentUri, to: targetUri });
    return { uri: targetUri, name: getNameFromUri(targetUri) };
  };

  const openFile = async (uri: string) => {
    appendLog(`Opening → ${uri}`);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri);
    } else {
      Linking.openURL(uri);
    }
  };

  // ---------------- network actions ----------------
  const refreshCustomers = async () => {
    try {
      setLoadingCust(true);
      appendLog(`Fetching customers for ${selectedOrg}…`);
      const list = await fetchCustomers(selectedOrg);
      setCustomers(list);
      await AsyncStorage.setItem(
        cacheKey,
        JSON.stringify({ customers: list, cachedAt: Date.now() })
      );
      setSnack({ visible: true, msg: `Fetched ${list.length} customers` });
      appendLog(`Loaded ${list.length} customers for ${selectedOrg} (cached).`);
    } catch (e: any) {
      setSnack({ visible: true, msg: `Failed to fetch customers` });
      appendLog(`❌ Failed to fetch customers: ${e?.message || e}`);
    } finally {
      setLoadingCust(false);
    }
  };

  const sendData = async () => {
    setIsWorking(true);
    setLog([]);
    try {
      const payload = {
        org: selectedOrg,
        customer: selectedCustomer,
        from: formatDateIso(fromDate),
        to: formatDateIso(toDate),
      };
      appendLog(
        `Sending → [${payload.org}] ${payload.customer} (${payload.from} → ${payload.to})`
      );

      const { fileUri, count, fileName } = await fetchInvoicesAndMerge(payload, appendLog);
      appendLog(`Merged ${count} invoices → ${fileName}`);
      appendLog(`Saved → ${fileUri}`);

      // 🔁 Rename to requested format
      const renamed = await renameMerged(fileUri, payload.org, payload.customer, payload.from, payload.to);
      if (renamed.uri !== fileUri) {
        appendLog(`Renamed → ${renamed.name}`);
      }

      await pushHistory({
        ...payload,
        file: renamed.name,
        uri: renamed.uri,
        time: new Date().toISOString(),
      });
      setHistory(await getHistory());

      setSnack({ visible: true, msg: '✅ PDF ready — sharing…' });
      await openFile(renamed.uri);
    } catch (e: any) {
      setSnack({ visible: true, msg: '❌ Error' });
      appendLog(`❌ Error: ${e?.message || e}`);
    } finally {
      setIsWorking(false);
    }
  };

  const runDS = async () => {
    setIsWorking(true);
    setLog([]);
    try {
      const dayStr = formatDateIso(getYesterday());

      for (let i = 0; i < QUICK_JOBS.DS.length; i++) {
        const job = { ...QUICK_JOBS.DS[i], from: dayStr, to: dayStr };
        appendLog(
          `DS ${i + 1}/${QUICK_JOBS.DS.length} → [${job.org}] ${job.customer} (${job.from})`
        );

        const { fileUri, count, fileName } = await fetchInvoicesAndMerge(job, appendLog);
        appendLog(`${job.org} merged ${count} → ${fileName}`);
        appendLog(`Saved → ${fileUri}`);

        // 🔁 Rename each DS file
        const renamed = await renameMerged(fileUri, job.org, job.customer, job.from, job.to);
        if (renamed.uri !== fileUri) {
          appendLog(`Renamed → ${renamed.name}`);
        }
        await openFile(renamed.uri);
      }

      setHistory(await getHistory());
      appendLog('DS finished ✅');
      setSnack({ visible: true, msg: '✅ DS done — sharing…' });
    } catch (e: any) {
      appendLog(`❌ DS error: ${e?.message || e}`);
      setSnack({ visible: true, msg: '❌ DS failed' });
    } finally {
      setIsWorking(false);
    }
  };

  // base dir (for showing paths under history items when sandbox path was used)
  const baseDir = (FS.documentDirectory ?? FS.cacheDirectory) + 'Anvaya/';

  // ---------------- UI ----------------
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
      {/* Filters */}
      <Card style={{ borderRadius: 16, overflow: 'hidden' }}>
        <Card.Title
          title="📝 Select Filters"
          subtitle="Choose org, customer and date range"
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
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Chip
              icon="office-building"
              onPress={() => setOrgModalVisible(true)}
              selected
              style={{ alignSelf: 'flex-start' }}
            >
              {ORGS.find((o) => o.key === selectedOrg)?.name || selectedOrg}
            </Chip>
          </View>

          {/* ORG modal */}
          <Portal>
            <Modal
              visible={orgModalVisible}
              onDismiss={() => setOrgModalVisible(false)}
              contentContainerStyle={{
                backgroundColor: 'white',
                margin: 16,
                borderRadius: 12,
                padding: 12,
                maxHeight: '70%',
              }}
            >
              <Text variant="titleMedium" style={{ marginBottom: 8 }}>
                Select Organisation
              </Text>
              {ORGS.map((o) => (
                <Button
                  key={o.key}
                  mode={o.key === selectedOrg ? 'contained' : 'outlined'}
                  style={{ marginBottom: 8 }}
                  onPress={() => {
                    setSelectedOrg(o.key as OrgKey);
                    setOrgModalVisible(false);
                  }}
                >
                  {o.name}
                </Button>
              ))}
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Button onPress={() => setOrgModalVisible(false)}>Close</Button>
              </View>
            </Modal>
          </Portal>

          {/* Customer picker */}
          <Text style={{ marginTop: 16, marginBottom: 6 }}>Customer</Text>
          <Button mode="outlined" onPress={() => setCustModalVisible(true)}>
            {selectedCustomer ? selectedCustomer : 'Select Customer'}
          </Button>

          {/* CUSTOMER modal */}
          <Portal>
            <Modal
              visible={custModalVisible}
              onDismiss={() => setCustModalVisible(false)}
              contentContainerStyle={{
                backgroundColor: 'white',
                margin: 16,
                borderRadius: 12,
                padding: 12,
                maxHeight: '80%',
              }}
            >
              <Text variant="titleMedium" style={{ marginBottom: 8 }}>
                Select Customer ({ORGS.find((o) => o.key === selectedOrg)?.name})
              </Text>

              <Searchbar
                placeholder="Search customers…"
                value={custQuery}
                onChangeText={setCustQuery}
                style={{ marginBottom: 8 }}
                autoCorrect={false}
                autoCapitalize="none"
              />

              {customers.length === 0 ? (
                <View style={{ alignItems: 'center', padding: 24 }}>
                  {loadingCust ? (
                    <ActivityIndicator />
                  ) : (
                    <Text>Tap refresh (top-right) to download customers</Text>
                  )}
                </View>
              ) : (
                <View style={{ maxHeight: '65%' }}>
                  <ScrollView keyboardShouldPersistTaps="handled">
                    {filteredCustomers.map((item) => (
                      <Button
                        key={item.customer_id}
                        mode="text"
                        onPress={() => {
                          setSelectedCustomer(item.customer_name);
                          setCustModalVisible(false);
                          setCustQuery('');
                        }}
                        style={{ justifyContent: 'flex-start' }}
                      >
                        {item.customer_name}
                      </Button>
                    ))}
                  </ScrollView>
                </View>
              )}

              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginTop: 8,
                }}
              >
                <Button onPress={() => setCustQuery('')} icon="close">
                  Clear
                </Button>
                <Button onPress={() => setCustModalVisible(false)}>Close</Button>
              </View>
            </Modal>
          </Portal>

          {/* Dates */}
          <Text style={{ marginTop: 16, marginBottom: 6 }}>From Date</Text>
          <Button mode="outlined" onPress={() => setShowFromPicker(true)}>
            {fromDate.toDateString()}
          </Button>
          {showFromPicker && (
            <DateTimePicker
              value={fromDate}
              mode="date"
              display="calendar"
              onChange={(event, selectedDate) => {
                setShowFromPicker(Platform.OS === 'ios');
                if (selectedDate) setFromDate(selectedDate);
                if (Platform.OS === 'android') setShowFromPicker(false);
              }}
            />
          )}

          <Text style={{ marginTop: 16, marginBottom: 6 }}>To Date</Text>
          <Button mode="outlined" onPress={() => setShowToPicker(true)}>
            {toDate.toDateString()}
          </Button>
          {showToPicker && (
            <DateTimePicker
              value={toDate}
              mode="date"
              display="calendar"
              onChange={(event, selectedDate) => {
                setShowToPicker(Platform.OS === 'ios');
                if (selectedDate) setToDate(selectedDate);
                if (Platform.OS === 'android') setShowToPicker(false);
              }}
            />
          )}

          <Button
            mode="contained"
            onPress={sendData}
            style={{ marginTop: 18, paddingVertical: 6, borderRadius: 10 }}
            disabled={!selectedCustomer || isWorking}
          >
            📤 Fetch & Merge
          </Button>
        </Card.Content>
      </Card>

      {/* Yesterday quick jobs */}
      <Card style={{ marginTop: 16, borderRadius: 16 }}>
        <Card.Title title="🗓 Yesterday" subtitle="One-tap quick jobs" />
        <Divider />
        <Card.Content>
          <Button mode="outlined" icon="lightning-bolt" onPress={runDS} disabled={isWorking}>
            DS
          </Button>
          <Text style={{ opacity: 0.7, marginTop: 6 }}>
            Runs for: PM → "SHREE DHOLI SATI TEXTILE PVT LTD JN", and MTM → "Shree Dholi Sati
            Textile Pvt Ltd" (yesterday)
          </Text>
        </Card.Content>
      </Card>

      {/* Activity (scrolling & auto-scroll) */}
      <Card style={{ marginTop: 16, borderRadius: 16 }}>
        <Card.Title
          title="📡 Activity"
          subtitle="Live status of the current task"
          right={() => (isWorking ? <ActivityIndicator style={{ marginRight: 16 }} /> : null)}
        />
        <Divider />
        <Card.Content>
          {log.length === 0 ? (
            <Text>Idle.</Text>
          ) : (
            <View style={{ height: 220 }}>
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

      {/* Download history */}
      <Card style={{ marginTop: 16, borderRadius: 16, marginBottom: 20 }}>
        <Card.Title title="🕘 Download History" subtitle="Last 5 merged PDFs" />
        <Divider />
        <Card.Content>
          {history.length === 0 ? (
            <Text>No history found.</Text>
          ) : (
            <View>
              {history.map((it) => {
                const displayUri = it.uri ?? (FS.documentDirectory ?? FS.cacheDirectory) + 'Anvaya/' + it.file;
                return (
                  <View key={it.time} style={{ marginBottom: 12 }}>
                    <Text variant="labelLarge">{it.customer}</Text>
                    <Text style={{ opacity: 0.8 }}>
                      [{it.org}] {it.from} → {it.to}
                    </Text>
                    <Button
                      icon="share-variant"
                      mode="outlined"
                      compact
                      onPress={() => openFile(displayUri)}
                      style={{ marginTop: 6, alignSelf: 'flex-start' }}
                    >
                      Open / Share
                    </Button>
                    <Text style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>{displayUri}</Text>
                  </View>
                );
              })}
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
