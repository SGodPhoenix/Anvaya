// src/lib/utils.ts
// Use legacy expo-file-system helpers for backwards-compatible paths.
import * as FS from 'expo-file-system/legacy';

export async function ensureDir(dir: string) {
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) {
    await FS.makeDirectoryAsync(dir, { intermediates: true });
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
