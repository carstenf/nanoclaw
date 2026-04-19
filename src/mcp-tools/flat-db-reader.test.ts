import { describe, it, expect, beforeEach } from 'vitest';
import {
  readFlatDb,
  clearFlatDbCache,
  FlatDbNotFound,
  FlatDbParseError,
} from './flat-db-reader.js';

// Minimal fs/promises shape used by readFlatDb
interface FakeFsStats {
  mtimeMs: number;
}

function makeFakeFs(opts: {
  stat?: (p: string) => Promise<FakeFsStats>;
  readFile?: (p: string, enc: string) => Promise<string>;
}) {
  return {
    stat: opts.stat ?? (async () => ({ mtimeMs: 1000 })),
    readFile: opts.readFile ?? (async () => '{}'),
  };
}

describe('readFlatDb', () => {
  beforeEach(() => {
    clearFlatDbCache();
  });

  it('returns parsed JSON from file on first read', async () => {
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: 1000 }),
      readFile: async () =>
        JSON.stringify({ contracts: [{ id: 'test', provider: 'Test AG' }] }),
    });

    const result = await readFlatDb<{
      contracts: Array<{ id: string; provider: string }>;
    }>('/fake/contracts.json', { contracts: [] }, { fs: fakeFs });

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].provider).toBe('Test AG');
  });

  it('uses cached value when mtime unchanged', async () => {
    let readCount = 0;
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: 5000 }),
      readFile: async () => {
        readCount++;
        return JSON.stringify({
          contracts: [{ id: `call-${readCount}`, provider: 'AG' }],
        });
      },
    });

    await readFlatDb('/fake/c.json', { contracts: [] }, { fs: fakeFs });
    await readFlatDb('/fake/c.json', { contracts: [] }, { fs: fakeFs });

    expect(readCount).toBe(1); // second call should hit cache
  });

  it('re-reads file when mtime changes (live-edit support)', async () => {
    let mtime = 1000;
    let readCount = 0;
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: mtime }),
      readFile: async () => {
        readCount++;
        return JSON.stringify({ v: readCount });
      },
    });

    const first = await readFlatDb<{ v: number }>(
      '/fake/c.json',
      { v: 0 },
      { fs: fakeFs },
    );
    mtime = 2000; // simulate file edit
    const second = await readFlatDb<{ v: number }>(
      '/fake/c.json',
      { v: 0 },
      { fs: fakeFs },
    );

    expect(first.v).toBe(1);
    expect(second.v).toBe(2);
    expect(readCount).toBe(2);
  });

  it('throws FlatDbNotFound when file does not exist (ENOENT)', async () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fakeFs = makeFakeFs({
      stat: async () => {
        throw enoentErr;
      },
    });

    await expect(
      readFlatDb('/fake/missing.json', {}, { fs: fakeFs }),
    ).rejects.toBeInstanceOf(FlatDbNotFound);
  });

  it('throws FlatDbParseError on invalid JSON', async () => {
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: 1000 }),
      readFile: async () => '{ broken json !!',
    });

    await expect(
      readFlatDb('/fake/bad.json', {}, { fs: fakeFs }),
    ).rejects.toBeInstanceOf(FlatDbParseError);
  });
});
