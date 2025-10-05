// src/lib/history.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OrgKey } from './zoho';

export type HistoryItem = {
  org: OrgKey;
  customer: string;
  from: string;
  to: string;
  file: string;   // filename (if we saved in app sandbox)
  uri?: string;   // full uri (e.g., content:// from SAF or file:///)
  time: string;
};

const KEY = 'anvaya_history_v1';

export async function getHistory(): Promise<HistoryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function pushHistory(item: HistoryItem) {
  const list = await getHistory();
  list.unshift(item);
  const trimmed = list.slice(0, 5);
  await AsyncStorage.setItem(KEY, JSON.stringify(trimmed));
}
