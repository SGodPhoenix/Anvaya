import React, { useEffect, useState } from 'react';
import { View, FlatList, RefreshControl } from 'react-native';
import { Appbar, Card, Text, IconButton, ActivityIndicator } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';

import { listBoutiqueFolders, syncBoutiqueImagesMTM } from '../lib/zoho';

type Props = NativeStackScreenProps<RootStackParamList, 'BoutiqueImages'>;

export default function BoutiqueImagesScreen({ navigation }: Props) {
  const [folders, setFolders] = useState<{ name: string; count: number }[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const pushLog = (s: string) => setLog((l) => [...l.slice(-100), s]);

  const load = async () => {
    setRefreshing(true);
    const f = await listBoutiqueFolders();
    setFolders(f);
    setRefreshing(false);
  };

  useEffect(() => {
    load();
  }, []);

  const onSync = async () => {
    setBusy(true);
    setLog([]);
    try {
      const res = await syncBoutiqueImagesMTM((s) => pushLog(s));
      pushLog(`✅ Synced. Downloaded: ${res.downloaded}`);
      await load();
    } catch (e: any) {
      pushLog(`❌ ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const openAndPrefillShareAll = (folder: string) => {
    navigation.navigate('BoutiqueFolder', { folder });
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f7f5fb' }}>
      <Appbar.Header mode="center-aligned">
        <Appbar.BackAction onPress={() => navigation.goBack()} />
        <Appbar.Content title="Boutique Images" />
        <Appbar.Action icon="refresh" onPress={onSync} disabled={busy} />
        {/* “Download” icon requested — here it triggers the same sync */}
        <Appbar.Action icon="download" onPress={onSync} disabled={busy} />
      </Appbar.Header>

      {busy ? (
        <View style={{ padding: 16, gap: 8 }}>
          <ActivityIndicator />
          {log.slice(-5).map((l, i) => (
            <Text key={i} style={{ opacity: 0.7 }}>{l}</Text>
          ))}
        </View>
      ) : null}

      <FlatList
        data={folders}
        keyExtractor={(x) => x.name}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        renderItem={({ item }) => (
          <Card
            onPress={() => navigation.navigate('BoutiqueFolder', { folder: item.name })}
            style={{ borderRadius: 16 }}
          >
            <Card.Title
              title={item.name}
              subtitle={`${item.count} image${item.count === 1 ? '' : 's'}`}
              right={(props) => (
                <IconButton
                  {...props}
                  icon="share-variant"
                  onPress={() => openAndPrefillShareAll(item.name)}
                />
              )}
            />
          </Card>
        )}
        ListEmptyComponent={
          <View style={{ padding: 20 }}>
            <Text>No folders yet. Tap refresh to sync images.</Text>
          </View>
        }
      />
    </View>
  );
}
