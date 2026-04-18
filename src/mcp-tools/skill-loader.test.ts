import { describe, it, expect, beforeEach } from 'vitest';
import { loadSkill, clearSkillCache } from './skill-loader.js';

// Minimal fs shape used by loadSkill
interface FakeFsStats {
  mtimeMs: number;
}

function makeFakeFs(opts: {
  stat?: (p: string) => Promise<FakeFsStats>;
  readFile?: (p: string, enc: string) => Promise<string>;
}) {
  return {
    stat:
      opts.stat ??
      (async () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      }),
    readFile: opts.readFile ?? (async () => ''),
  };
}

describe('loadSkill', () => {
  beforeEach(() => {
    clearSkillCache();
  });

  it('happy path: returns exists:true and body when SKILL.md is readable', async () => {
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: 1000 }),
      readFile: async () => '# Test Skill\nYou are a test skill.',
    });

    const result = await loadSkill('test', { skillsDir: '/skills', fs: fakeFs });

    expect(result.exists).toBe(true);
    expect(result.body).toBe('# Test Skill\nYou are a test skill.');
    expect(result.path).toBe('/skills/ask-core-test/SKILL.md');
  });

  it('ENOENT: returns exists:false, body:null when file missing', async () => {
    const fakeFs = makeFakeFs({
      stat: async () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      },
    });

    const result = await loadSkill('nope', { skillsDir: '/skills', fs: fakeFs });

    expect(result.exists).toBe(false);
    expect(result.body).toBeNull();
    expect(result.path).toBe('/skills/ask-core-nope/SKILL.md');
  });

  it('mtime cache hit: second call does not re-read file', async () => {
    let readCount = 0;
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: 5000 }),
      readFile: async () => {
        readCount++;
        return `call-${readCount}`;
      },
    });

    const first = await loadSkill('echo', { skillsDir: '/skills', fs: fakeFs });
    const second = await loadSkill('echo', { skillsDir: '/skills', fs: fakeFs });

    expect(readCount).toBe(1);
    expect(first.body).toBe('call-1');
    expect(second.body).toBe('call-1'); // cached
  });

  it('mtime cache miss: re-reads file when mtime changes', async () => {
    let mtime = 1000;
    let readCount = 0;
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: mtime }),
      readFile: async () => {
        readCount++;
        return `version-${readCount}`;
      },
    });

    const first = await loadSkill('echo', { skillsDir: '/skills', fs: fakeFs });
    mtime = 2000; // simulate file edit
    const second = await loadSkill('echo', { skillsDir: '/skills', fs: fakeFs });

    expect(readCount).toBe(2);
    expect(first.body).toBe('version-1');
    expect(second.body).toBe('version-2');
  });

  it('JSON fixture: result shape matches SkillLoadResult interface', async () => {
    const fakeFs = makeFakeFs({
      stat: async () => ({ mtimeMs: 99 }),
      readFile: async () => 'skill body text',
    });

    const result = await loadSkill('my-topic', {
      skillsDir: '/base',
      fs: fakeFs,
    });

    // Verify shape (acts as JSON schema fixture)
    expect(typeof result.exists).toBe('boolean');
    expect(typeof result.path).toBe('string');
    expect(result.exists === true ? typeof result.body : result.body).toBe(
      result.exists ? 'string' : null,
    );
    expect(result.path).toContain('ask-core-my-topic');
  });
});
