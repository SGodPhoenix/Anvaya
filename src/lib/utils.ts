// src/lib/utils.ts
// Use main expo-file-system for paths; use legacy only for deprecated helpers.
import * as FS from 'expo-file-system';
import * as FSLegacy from 'expo-file-system/legacy';

export async function ensureDir(dir: string) {
  // legacy calls avoid SDK 54 deprecation logs while we keep behavior
  const info = await FSLegacy.getInfoAsync(dir);
  if (!info.exists) {
    await FSLegacy.makeDirectoryAsync(dir, { intermediates: true });
  }
}

export function uniqueName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Convenience so other modules can see what our default base dir would be.
export function getPreferredBaseDir() {
  return FS.documentDirectory ?? FS.cacheDirectory ?? null;
}
