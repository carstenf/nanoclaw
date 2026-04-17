import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track instances created by OAuth2 constructor across tests
let oauthInstances: Array<{ setCredentials: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }> = [];

// Mock googleapis before any imports that use it
vi.mock('googleapis', () => {
  const calendarMock = {
    events: {
      list: vi.fn(),
      insert: vi.fn(),
    },
  };

  function OAuth2Mock(
    this: { setCredentials: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> },
  ) {
    this.setCredentials = vi.fn();
    this.on = vi.fn();
    oauthInstances.push(this);
  }

  return {
    google: {
      auth: { OAuth2: OAuth2Mock },
      calendar: vi.fn().mockReturnValue(calendarMock),
    },
  };
});

import { google } from 'googleapis';
import { getCalendarClient, CalendarClientError } from './calendar-client.js';

const FAKE_KEYS = JSON.stringify({
  installed: {
    client_id: 'client-id-test',
    client_secret: 'client-secret-test',
    redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
  },
});

const FAKE_TOKENS = JSON.stringify({
  default: {
    access_token: 'access-token-test',
    refresh_token: 'refresh-token-test',
    expiry_date: Date.now() + 3600 * 1000,
    token_type: 'Bearer',
  },
});

function makeFakeFs(credsContent: string, tokensContent: string) {
  return {
    readFile: vi.fn().mockImplementation(async (p: string) => {
      if (String(p).includes('gcp-oauth')) return credsContent;
      if (String(p).includes('tokens')) return tokensContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
}

describe('getCalendarClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauthInstances = [];
  });

  it('happy path: returns calendar instance with OAuth2 set up', async () => {
    const fakeFs = makeFakeFs(FAKE_KEYS, FAKE_TOKENS);

    const client = await getCalendarClient({
      credsPath: '/fake/gcp-oauth.keys.json',
      tokensPath: '/fake/tokens.json',
      fs: fakeFs as never,
    });

    // Should have read both files
    expect(fakeFs.readFile).toHaveBeenCalledTimes(2);

    // google.calendar was called to create the client
    expect(google.calendar).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v3' }),
    );

    // The returned client is the mock calendar object
    expect(client).toBeDefined();
  });

  it('registers tokens event listener for auto-refresh persistence', async () => {
    const fakeFs = makeFakeFs(FAKE_KEYS, FAKE_TOKENS);

    await getCalendarClient({
      credsPath: '/fake/gcp-oauth.keys.json',
      tokensPath: '/fake/tokens.json',
      fs: fakeFs as never,
    });

    expect(oauthInstances).toHaveLength(1);
    const oauthInstance = oauthInstances[0];
    // 'on' listener registered for 'tokens' event
    expect(oauthInstance.on).toHaveBeenCalledWith('tokens', expect.any(Function));
  });

  it('token-refresh-triggered: tokens event triggers atomic tmp+rename', async () => {
    const fakeFs = makeFakeFs(FAKE_KEYS, FAKE_TOKENS);

    await getCalendarClient({
      credsPath: '/fake/gcp-oauth.keys.json',
      tokensPath: '/fake/tokens.json',
      fs: fakeFs as never,
    });

    expect(oauthInstances).toHaveLength(1);
    const oauthInstance = oauthInstances[0];
    const [, tokensListener] = oauthInstance.on.mock.calls[0] as [
      string,
      (t: object) => Promise<void>,
    ];

    // Simulate a token refresh event
    await tokensListener({ access_token: 'new-access-token' });

    // Should read the tokens file (to merge), write to .tmp, then rename atomically
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      expect.any(String),
    );
    expect(fakeFs.rename).toHaveBeenCalled();

    // The renamed file should be the original tokens path
    const [tmpPath, finalPath] = fakeFs.rename.mock.calls[0] as [string, string];
    expect(tmpPath).toMatch(/\.tmp$/);
    expect(finalPath).not.toMatch(/\.tmp$/);
  });

  it('throws CalendarClientError(creds_missing) when credential file missing', async () => {
    const fakeFs = {
      readFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      ),
      writeFile: vi.fn(),
      rename: vi.fn(),
    };

    await expect(
      getCalendarClient({
        credsPath: '/nonexistent/gcp-oauth.keys.json',
        tokensPath: '/nonexistent/tokens.json',
        fs: fakeFs as never,
      }),
    ).rejects.toThrow(CalendarClientError);

    try {
      await getCalendarClient({
        credsPath: '/nonexistent/gcp-oauth.keys.json',
        tokensPath: '/nonexistent/tokens.json',
        fs: fakeFs as never,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CalendarClientError);
      expect((e as CalendarClientError).code).toBe('creds_missing');
    }
  });

  it('throws CalendarClientError(creds_missing) when tokens file missing', async () => {
    const fakeFs = {
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (String(p).includes('gcp-oauth')) return FAKE_KEYS;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      writeFile: vi.fn(),
      rename: vi.fn(),
    };

    await expect(
      getCalendarClient({
        credsPath: '/fake/gcp-oauth.keys.json',
        tokensPath: '/nonexistent/tokens.json',
        fs: fakeFs as never,
      }),
    ).rejects.toThrow(CalendarClientError);
  });
});
