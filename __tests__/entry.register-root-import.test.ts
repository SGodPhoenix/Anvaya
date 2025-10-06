declare function describe(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void): void;
declare function expect(actual: unknown): { toBe(expected: unknown): void; toBeLessThanOrEqual(expected: number): void; length?: number };

import fs from 'fs';

describe('index.tsx registerRootComponent', () => {
  test('imports registerRootComponent once', () => {
    const code = fs.readFileSync('index.tsx', 'utf8');
    const importMatches = code.match(/^\s*import\s*{\s*registerRootComponent\s*}\s*from\s*['"]expo['"];?$/gm) || [];
    expect(importMatches.length).toBeLessThanOrEqual(1);
  });

  test('calls registerRootComponent exactly once', () => {
    const code = fs.readFileSync('index.tsx', 'utf8');
    const callMatches = code.match(/registerRootComponent\s*\(/g) || [];
    expect(callMatches.length).toBe(1);
  });
});
