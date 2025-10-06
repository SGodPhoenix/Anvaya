// src/screens/HomeScreen.tsx
import React from 'react';
import {
  View,
  ImageBackground,
  StyleSheet,
  StatusBar,
  ScrollView,
  Platform,
  SafeAreaView,
} from 'react-native';
import { Card, Text, TouchableRipple, useTheme, Icon } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

const features: Array<{
  key: keyof RootStackParamList;
  title: string;
  subtitle: string;
  icon: string;
  tint: string;
}> = [
  { key: 'Form',              title: 'Fetch Invoices',      subtitle: 'Merge PDFs by date & customer', icon: 'file-download-outline',        tint: '#7A8CFF' },
  { key: 'Dispatch',          title: 'Dispatch Details',    subtitle: 'Invoice-wise LR & transport',   icon: 'truck-outline',                 tint: '#4ED1A1' },
  { key: 'DispatchItemWise',  title: 'Dispatch Item Wise',  subtitle: 'MTM • item-level dispatch PDF', icon: 'view-list-outline',             tint: '#B39DDB' },

  // ⬇️ NEW: Sale Order Status (placed above Pending Dispatch)
  { key: 'SaleOrderStatus',   title: 'Sale Order Status',   subtitle: 'MTM • last 6 months',           icon: 'file-document-check-outline',   tint: '#6ED3CF' },

  { key: 'PendingDispatch',   title: 'Pending Dispatch',    subtitle: 'MTM • last 12 months',          icon: 'clipboard-list-outline',        tint: '#FFB86B' },
  { key: 'BoutiqueImages',    title: 'Boutique Images',     subtitle: 'Sync, browse & share',          icon: 'image-multiple-outline',        tint: '#F47B94' },
  { key: 'Outstanding',       title: 'Outstanding',         subtitle: 'Firm → Customer → View & PDF',  icon: 'clipboard-text-outline',        tint: '#9AD0F5' },
  { key: 'NewSaleOrder',      title: 'New Sale Order',      subtitle: 'MTM • Excel price-book',        icon: 'cart-plus',                     tint: '#87CEEB' },
];

export default function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const navigateTo = (route: keyof RootStackParamList) => navigation.navigate(route as any);

  return (
    <ImageBackground
      source={{
        // Futuristic/tech texture; replace with a local asset later if desired.
        uri: 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?q=80&w=1600',
      }}
      style={{ flex: 1 }}
      blurRadius={8}
    >
      <StatusBar barStyle="light-content" />
      <View style={styles.bgVeil} />

      <SafeAreaView style={{ flex: 1 }}>
        {/* Extra top inset for Android where SafeArea is shallow */}
        <View style={{ height: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) / 2 : 0 }} />

        <View style={styles.page}>
          {/* ===== Artistic Header ===== */}
          <View style={{ height: 28 }} />
          <View style={styles.headerWrap}>
            <View style={styles.headerCard}>
              {/* soft halo accents */}
              <View style={[styles.halo, { backgroundColor: 'rgba(123, 97, 255, 0.16)', right: -18, top: -18 }]} />
              <View style={[styles.halo, { backgroundColor: 'rgba(78, 209, 161, 0.14)', left: -22, bottom: -22 }]} />

              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                {/* tiny emblem (infinity + orbit), very subtle */}
                <View style={styles.emblem}>
                  <Icon source="infinity" size={18} color="rgba(0,0,0,0.75)" />
                </View>
                <Text variant="headlineMedium" style={styles.brandTitle}>Anvaya</Text>
              </View>

              <Text style={styles.brandQuote}>
                “Anything is possible, all one needs is the imagination and the will to do it” — <Text style={styles.brandQuoteStrong}>Madhava</Text>
              </Text>
            </View>
          </View>

          {/* ===== Feature List (rows) ===== */}
          <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
            {features.map((f) => (
              <TouchableRipple
                key={f.key as string}
                rippleColor="rgba(0,0,0,0.08)"
                onPress={() => navigateTo(f.key)}
                style={{ marginBottom: 12 }}
              >
                <Card mode="elevated" style={styles.rowCard}>
                  {/* Accent strip */}
                  <View style={[styles.accent, { backgroundColor: f.tint }]} />
                  <View style={styles.rowContent}>
                    <View style={styles.rowIconWrap}>
                      <Icon source={f.icon} size={26} color="rgba(0,0,0,0.82)" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="titleMedium" style={styles.rowTitle}>{f.title}</Text>
                      <Text style={styles.rowSub}>{f.subtitle}</Text>
                    </View>
                    <Icon source="chevron-right" size={22} color={theme.colors.primary} />
                  </View>
                </Card>
              </TouchableRipple>
            ))}
          </ScrollView>
        </View>
      </SafeAreaView>
    </ImageBackground>
  );
}

/* =================== styles =================== */
const styles = StyleSheet.create({
  bgVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,12,16,0.38)',
  },
  page: {
    flex: 1,
    paddingHorizontal: 18,
  },

  /* Header */
  headerWrap: {
    paddingTop: 8,
    paddingBottom: 14,
  },
  headerCard: {
    borderRadius: 22,
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.96)',
    overflow: 'hidden',
  },
  halo: {
    position: 'absolute',
    height: 120,
    width: 120,
    borderRadius: 30,
    transform: [{ rotate: '18deg' }],
    // RN ignores filter on native; kept for intent if used on web
    // @ts-ignore
    filter: 'blur(6px)',
  },
  emblem: {
    height: 28,
    width: 28,
    borderRadius: 8,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  brandTitle: {
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  brandQuote: {
    opacity: 0.78,
    lineHeight: 20,
  },
  brandQuoteStrong: {
    fontWeight: '700',
    opacity: 0.9,
  },

  /* Rows */
  rowCard: {
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.95)',
    overflow: 'hidden',
  },
  accent: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    width: 6,
    opacity: 0.9,
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
  },
  rowIconWrap: {
    height: 40, width: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  rowTitle: {
    fontWeight: '700',
  },
  rowSub: {
    opacity: 0.66,
    marginTop: 2,
    fontSize: 13,
  },
});
