// src/voice-config.test.ts
//
// v1.4.0 — unit tests for the voice-config.json reader/writer.
// Uses a temp dir per test so vitest runs are hermetic and parallel-safe.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readVoiceConfig, writeVoiceConfig } from './voice-config.js';

let tmpDir: string;
let cfgPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-config-test-'));
  cfgPath = path.join(tmpDir, 'voice-config.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readVoiceConfig', () => {
  it('returns {} when the file is missing', () => {
    expect(readVoiceConfig(cfgPath)).toEqual({});
  });

  it('parses a valid JSON object', () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ operator_name: 'Carsten', operator_cli_number: '+491701234567' }),
    );
    expect(readVoiceConfig(cfgPath)).toEqual({
      operator_name: 'Carsten',
      operator_cli_number: '+491701234567',
    });
  });

  it('returns {} on malformed JSON', () => {
    fs.writeFileSync(cfgPath, '{ not valid json');
    expect(readVoiceConfig(cfgPath)).toEqual({});
  });

  it('returns {} when the JSON root is an array', () => {
    fs.writeFileSync(cfgPath, '[1,2,3]');
    expect(readVoiceConfig(cfgPath)).toEqual({});
  });

  it('returns {} when the JSON root is null', () => {
    fs.writeFileSync(cfgPath, 'null');
    expect(readVoiceConfig(cfgPath)).toEqual({});
  });
});

describe('writeVoiceConfig', () => {
  it('creates the file with merged values', () => {
    const result = writeVoiceConfig({ operator_name: 'Carsten' }, cfgPath);
    expect(result).toEqual({ operator_name: 'Carsten' });
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))).toEqual({
      operator_name: 'Carsten',
    });
  });

  it('merges with existing values without losing other keys', () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ operator_name: 'Carsten', operator_cli_number: '+491701234567' }),
    );
    const result = writeVoiceConfig({ operator_name: 'Sebastian' }, cfgPath);
    expect(result).toEqual({
      operator_name: 'Sebastian',
      operator_cli_number: '+491701234567',
    });
  });

  it('removes a key when set to empty string', () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ operator_name: 'Carsten', operator_cli_number: '+491701234567' }),
    );
    const result = writeVoiceConfig({ operator_cli_number: '' }, cfgPath);
    expect(result).toEqual({ operator_name: 'Carsten' });
    expect(result.operator_cli_number).toBeUndefined();
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'voice-config.json');
    writeVoiceConfig({ operator_name: 'Carsten' }, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('writes atomically (temp + rename leaves no .tmp file)', () => {
    writeVoiceConfig({ operator_name: 'Carsten' }, cfgPath);
    const leftover = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes('.tmp.'));
    expect(leftover).toHaveLength(0);
  });
});
