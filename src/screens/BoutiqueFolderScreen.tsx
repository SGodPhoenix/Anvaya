// src/screens/BoutiqueFolderScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { View, Image, FlatList, TouchableOpacity, Alert, Platform } from 'react-native';
import { Appbar, Button, Checkbox, Text, IconButton, Snackbar } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { listImagesInFolder } from '../lib/zoho';

import * as FSLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { PDFDocument } from 'pdf-lib';
import { toByteArray, fromByteArray } from 'base64-js';
import { ensureDir } from '../lib/utils';

type Props = NativeStackScreenProps<RootStackParamList, 'BoutiqueFolder'>;

export default function BoutiqueFolderScreen({ route, navigation }: Props) {
  const { folder } = route.params;
  const [uris, setUris] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [snack, setSnack] = useState<string | null>(null);

  const selectedUris = useMemo(() => uris.filter((u) => selected[u]), [uris, selected]);

  useEffect(() => {
    (async () => {
      const imgs = await listImagesInFolder(folder);
      setUris(imgs);
      setSelected({});
    })();
  }, [folder]);

  const toggle = (uri: string) => setSelected((s) => ({ ...s, [uri]: !s[uri] }));
  const selectAll = () => setSelected(Object.fromEntries(uris.map((u) => [u, true])));
  const clearAll = () => setSelected({});

  const getExt = (u: string) => (u.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
  const mimeFromUri = (u: string) => {
    const ext = getExt(u);
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'pdf') return 'application/pdf';
    return undefined;
  };

  /** Ensure we share a file:// path. If not file://, copy into cache first. */
  const toSharableFile = async (uri: string) => {
    if (uri.startsWith('file://')) return uri;
    const name = uri.split('/').pop() || `share-${Date.now()}`;
    const dir = (FSLegacy.cacheDirectory || FSLegacy.documentDirectory)! + `Anvaya/Share/${folder}/`;
    await ensureDir(dir);
    const dest = dir + name;
    try {
      await FSLegacy.copyAsync({ from: uri, to: dest });
      return dest;
    } catch {
      // If copy fails (rare), just return original; Sharing may still handle it on iOS.
      return uri;
    }
  };

  /** Single file share (Expo Go OK). */
  const shareOne = async (uri: string) => {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
        return;
      }
      const file = await toSharableFile(uri);
      await Sharing.shareAsync(file, {
        mimeType: mimeFromUri(file),
        dialogTitle: 'Share image',
      });
    } catch (e: any) {
      Alert.alert('Share failed', e?.message || String(e));
    }
  };

  /** Multi-file WhatsApp via react-native-share (APK build only). */
  const tryRNMultiShare = async (files: string[]) => {
    try {
      const RNShare = (await import('react-native-share')) as any; // dynamic import; Expo Go will fail here
      const urls = await Promise.all(files.map(toSharableFile));
      await RNShare.default.open({
        urls,
        social: RNShare.Social.WHATSAPP,
        failOnCancel: false,
      });
      return true;
    } catch {
      return false;
    }
  };

  /** Export selected images to a single PDF and share (Expo Go OK). */
  const exportSelectedToPdfAndShare = async () => {
    if (!selectedUris.length) {
      Alert.alert('Nothing selected', 'Pick one or more images first.');
      return;
    }
    setSnack('Building PDF…');

    try {
      const pdf = await PDFDocument.create();

      for (const uri of selectedUris) {
        const file = await toSharableFile(uri);
        const b64 = await FSLegacy.readAsStringAsync(file, { encoding: FSLegacy.EncodingType.Base64 });
        const bin = toByteArray(b64);

        const isPng = bin[0] === 0x89 && bin[1] === 0x50; // PNG signature
        const img = isPng ? await pdf.embedPng(bin) : await pdf.embedJpg(bin);

        // A4 portrait
        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const page = pdf.addPage([pageWidth, pageHeight]);

        const margin = 20;
        const maxW = pageWidth - margin * 2;
        const maxH = pageHeight - margin * 2;
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;

        page.drawImage(img, {
          x: (pageWidth - w) / 2,
          y: (pageHeight - h) / 2,
          width: w,
          height: h,
        });
      }

      const out = await pdf.save(); // Uint8Array
      const dir = (FSLegacy.documentDirectory || FSLegacy.cacheDirectory)! + 'Anvaya/BoutiquePDF/';
      await ensureDir(dir);
      const file = `${dir}${folder}_${Date.now()}.pdf`;

      // write as base64 (no Buffer/btoa in RN)
      const b64out = fromByteArray(out);
      await FSLegacy.writeAsStringAsync(file, b64out, { encoding: FSLegacy.EncodingType.Base64 });

      setSnack('Sharing PDF…');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share images as PDF',
        });
      } else {
        Alert.alert('Sharing unavailable', 'Unable to open the system share sheet.');
      }
    } catch (e: any) {
      Alert.alert('PDF error', e?.message || String(e));
    } finally {
      setSnack(null);
    }
  };

  const onShare = async () => {
    if (!selectedUris.length) {
      Alert.alert('Nothing selected', 'Pick one or more images first.');
      return;
    }

    if (selectedUris.length > 1) {
      const ok = await tryRNMultiShare(selectedUris);
      if (ok) return;

      Alert.alert(
        'Multi-share needs APK',
        'Expo Go cannot share multiple files directly. You can:\n\n• Share one image at a time, or\n• Export selected images into one PDF and share that.',
        [
          { text: 'Share first image', onPress: () => shareOne(selectedUris[0]) },
          { text: 'Share as PDF', onPress: exportSelectedToPdfAndShare },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    await shareOne(selectedUris[0]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f7f5fb' }}>
      <Appbar.Header mode="center-aligned">
        <Appbar.BackAction onPress={() => navigation.goBack()} />
        <Appbar.Content title={`Folder: ${folder}`} />
        <Appbar.Action icon="select-all" onPress={selectAll} />
        <Appbar.Action icon="checkbox-blank-off-outline" onPress={clearAll} />
        <Appbar.Action icon="share-variant" onPress={onShare} />
      </Appbar.Header>

      <FlatList
        data={uris}
        keyExtractor={(u) => u}
        numColumns={3}
        contentContainerStyle={{ padding: 8 }}
        renderItem={({ item }) => {
          const isSel = !!selected[item];
          return (
            <TouchableOpacity onPress={() => toggle(item)} style={{ width: '33.333%', padding: 6 }}>
              <View
                style={{
                  borderRadius: 12,
                  overflow: 'hidden',
                  position: 'relative',
                  borderWidth: isSel ? 2 : 0,
                  borderColor: '#6c63ff',
                }}
              >
                <Image
                  source={{ uri: item }}
                  style={{ width: '100%', aspectRatio: 1, backgroundColor: '#eee' }}
                  resizeMode="cover"
                />
                <Checkbox
                  status={isSel ? 'checked' : 'unchecked'}
                  onPress={() => toggle(item)}
                  color="#6c63ff"
                  uncheckedColor="#fff"
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    backgroundColor: 'rgba(0,0,0,0.25)',
                    borderRadius: 12,
                  }}
                />
              </View>
            </TouchableOpacity>
          );
        }}
        ListHeaderComponent={
          <View
            style={{
              paddingHorizontal: 12,
              paddingTop: 12,
              paddingBottom: 4,
              flexDirection: 'row',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <IconButton icon="select-all" onPress={selectAll} />
            <IconButton icon="checkbox-blank-off-outline" onPress={clearAll} />
            <Button mode="contained" onPress={onShare} style={{ borderRadius: 10 }}>
              Share
            </Button>
            <Button mode="outlined" onPress={exportSelectedToPdfAndShare} style={{ borderRadius: 10 }}>
              Share as PDF
            </Button>
          </View>
        }
        ListEmptyComponent={
          <View style={{ padding: 20 }}>
            <Text>No images in this folder.</Text>
          </View>
        }
      />

      <Snackbar visible={!!snack} onDismiss={() => setSnack(null)} duration={1500}>
        {snack}
      </Snackbar>
    </View>
  );
}
