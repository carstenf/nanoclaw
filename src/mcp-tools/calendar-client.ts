import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';

import { google, calendar_v3 } from 'googleapis';

export class CalendarClientError extends Error {
  constructor(
    public readonly code: 'creds_missing' | 'creds_invalid',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CalendarClientError';
  }
}

export interface CalendarClientOpts {
  /** Path to gcp-oauth.keys.json. Default: GCALENDAR_CREDS_PATH env or ~/.gcalendar-mcp/gcp-oauth.keys.json */
  credsPath?: string;
  /** Path to tokens.json. Default: GCALENDAR_TOKENS_PATH env or ~/.gcalendar-mcp/google-calendar-mcp/tokens.json */
  tokensPath?: string;
  /** Clock function for testing. Default: Date.now */
  now?: () => number;
  /** fs/promises override for DI in tests */
  fs?: Pick<typeof fsPromises, 'readFile' | 'writeFile' | 'rename'>;
}

function defaultCredsPath(): string {
  return (
    process.env.GCALENDAR_CREDS_PATH ??
    path.join(os.homedir(), '.gcalendar-mcp', 'gcp-oauth.keys.json')
  );
}

function defaultTokensPath(): string {
  return (
    process.env.GCALENDAR_TOKENS_PATH ??
    path.join(
      os.homedir(),
      '.gcalendar-mcp',
      'google-calendar-mcp',
      'tokens.json',
    )
  );
}

/**
 * Returns a fresh google.calendar client per call.
 *
 * No Singleton — fresh client per invocation so concurrent calls are isolated.
 * Token refresh is automatic via googleapis oauth event; written atomically (tmp+rename).
 *
 * @throws CalendarClientError('creds_missing') if either credential file is unreadable.
 */
export async function getCalendarClient(
  opts: CalendarClientOpts = {},
): Promise<calendar_v3.Calendar> {
  const fs = opts.fs ?? fsPromises;
  const credsPath = opts.credsPath ?? defaultCredsPath();
  const tokensPath = opts.tokensPath ?? defaultTokensPath();

  // Read both credential files; surface missing-file as CalendarClientError
  let keysRaw: string;
  let tokensRaw: string;
  try {
    keysRaw = await fs.readFile(credsPath, 'utf8');
  } catch {
    throw new CalendarClientError(
      'creds_missing',
      `Cannot read creds: ${credsPath}`,
    );
  }
  try {
    tokensRaw = await fs.readFile(tokensPath, 'utf8');
  } catch {
    throw new CalendarClientError(
      'creds_missing',
      `Cannot read tokens: ${tokensPath}`,
    );
  }

  let keysJson: {
    installed?: {
      client_id: string;
      client_secret: string;
      redirect_uris: string[];
    };
  };
  let tokensJson: {
    default?: {
      access_token?: string;
      refresh_token?: string;
      expiry_date?: number;
      token_type?: string;
    };
  };
  try {
    keysJson = JSON.parse(keysRaw);
    tokensJson = JSON.parse(tokensRaw);
  } catch {
    throw new CalendarClientError(
      'creds_invalid',
      'Credential file JSON parse error',
    );
  }

  const installed = keysJson.installed;
  if (!installed) {
    throw new CalendarClientError(
      'creds_invalid',
      'Missing "installed" key in gcp-oauth.keys.json',
    );
  }

  const defaultToken = tokensJson.default ?? {};

  const oauth = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris?.[0] ?? 'urn:ietf:wg:oauth:2.0:oob',
  );

  oauth.setCredentials({
    access_token: defaultToken.access_token,
    refresh_token: defaultToken.refresh_token,
    expiry_date: defaultToken.expiry_date,
    token_type: defaultToken.token_type,
  });

  // Atomic token persistence on auto-refresh.
  // Register BEFORE any refreshAccessToken() call so the event is captured.
  oauth.on('tokens', async (updatedTokens) => {
    if (!updatedTokens.refresh_token && !updatedTokens.access_token) return;
    try {
      // Re-read to get latest (another process may have updated)
      const latestRaw = await fs.readFile(tokensPath, 'utf8');
      const latestJson = JSON.parse(latestRaw) as typeof tokensJson;
      const safeTokens = {
        access_token: updatedTokens.access_token ?? undefined,
        refresh_token: updatedTokens.refresh_token ?? undefined,
        expiry_date: updatedTokens.expiry_date ?? undefined,
        token_type: updatedTokens.token_type ?? undefined,
      };
      latestJson.default = { ...(latestJson.default ?? {}), ...safeTokens };
      const tmp = tokensPath + '.tmp';
      // atomic: write to .tmp then rename (Linux: same-fs rename is atomic)
      await fs.writeFile(tmp, JSON.stringify(latestJson, null, 2));
      await fs.rename(tmp, tokensPath);
    } catch {
      // Non-fatal: next call will refresh again
    }
  });

  // If access_token is missing or clearly stale (expiry_date=0), force a refresh
  // before the caller uses the client. This avoids invalid_grant on the first call
  // when the token file only contains a refresh_token (common after initial auth).
  const needsRefresh =
    !defaultToken.access_token || defaultToken.expiry_date === 0;
  if (needsRefresh && defaultToken.refresh_token) {
    try {
      await oauth.refreshAccessToken();
      // 'tokens' event fires during refreshAccessToken and persists atomically.
    } catch {
      // Non-fatal — API call will fail and surface the error if truly invalid.
    }
  }

  return google.calendar({ version: 'v3', auth: oauth });
}
