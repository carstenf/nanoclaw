/**
 * maps-client.ts
 *
 * Thin fetch-based client for Google Maps Distance Matrix API.
 * No SDK dependency — raw fetch + AbortController timeout.
 * Endpoint: https://maps.googleapis.com/maps/api/distancematrix/json
 *
 * Key is passed as a query param (`?key=...`) per Google Distance Matrix spec.
 * DI: opts.fetch (default globalThis.fetch), opts.apiKey (required).
 */

const DISTANCEMATRIX_URL =
  'https://maps.googleapis.com/maps/api/distancematrix/json';

export type MapsClientErrorCode =
  | 'missing_key'
  | 'zero_results'
  | 'not_found'
  | 'invalid_request'
  | 'over_query_limit'
  | 'request_denied'
  | 'unknown'
  | 'timeout'
  | 'network';

export class MapsClientError extends Error {
  constructor(
    public readonly code: MapsClientErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'MapsClientError';
  }
}

export interface TravelTimeResult {
  duration_seconds: number;
  distance_meters: number;
  duration_text: string;
  distance_text: string;
  origin_resolved: string;
  destination_resolved: string;
  mode: string;
  used_traffic: boolean; // true when duration_in_traffic was used
}

export interface GetTravelTimeOpts {
  origin: string;
  destination: string;
  mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
  /** 'now' | ISO 8601 — only applied when mode=driving */
  departureTime?: string;
  apiKey: string; // required — throw MapsClientError('missing_key') if empty
  timeoutMs?: number;
  /** Fetch override for DI in tests. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
}

// Google Distance Matrix top-level status codes
const TOP_STATUS_MAP: Record<string, MapsClientErrorCode> = {
  INVALID_REQUEST: 'invalid_request',
  OVER_QUERY_LIMIT: 'over_query_limit',
  REQUEST_DENIED: 'request_denied',
  UNKNOWN_ERROR: 'unknown',
};

// Google Distance Matrix element-level status codes
const ELEMENT_STATUS_MAP: Record<string, MapsClientErrorCode> = {
  NOT_FOUND: 'not_found',
  ZERO_RESULTS: 'zero_results',
  MAX_ROUTE_LENGTH_EXCEEDED: 'zero_results',
};

interface DistanceMatrixResponse {
  status: string;
  origin_addresses: string[];
  destination_addresses: string[];
  rows: Array<{
    elements: Array<{
      status: string;
      duration?: { value: number; text: string };
      distance?: { value: number; text: string };
      duration_in_traffic?: { value: number; text: string };
    }>;
  }>;
}

/**
 * Fetch travel time from Google Maps Distance Matrix API.
 *
 * Always 1 origin + 1 destination → reads rows[0].elements[0].
 * For driving + departure_time: uses duration_in_traffic when present.
 *
 * @throws {MapsClientError} on any error (API error, timeout, network, missing key)
 */
export async function getTravelTime(
  opts: GetTravelTimeOpts,
): Promise<TravelTimeResult> {
  if (!opts.apiKey) {
    throw new MapsClientError('missing_key', 'apiKey is required');
  }

  const mode = opts.mode ?? 'driving';
  const timeoutMs = opts.timeoutMs ?? 6000;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  // Build query params
  const params = new URLSearchParams({
    origins: opts.origin,
    destinations: opts.destination,
    mode,
    key: opts.apiKey,
  });

  // departure_time is only valid for driving mode
  if (mode === 'driving' && opts.departureTime) {
    params.set('departure_time', opts.departureTime);
  }

  const url = `${DISTANCEMATRIX_URL}?${params.toString()}`;

  // Abort controller for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data: DistanceMatrixResponse;
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    data = (await response.json()) as DistanceMatrixResponse;
  } catch (err) {
    clearTimeout(timer);
    if (
      err instanceof Error &&
      (err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        err.message.includes('aborted') ||
        err.message.includes('timeout'))
    ) {
      throw new MapsClientError('timeout', 'Request timed out');
    }
    // DOMException with name AbortError (browser/node fetch)
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new MapsClientError('timeout', 'Request timed out');
    }
    throw new MapsClientError(
      'network',
      err instanceof Error ? err.message : String(err),
    );
  }
  clearTimeout(timer);

  // Check top-level status
  if (data.status !== 'OK') {
    const code: MapsClientErrorCode = TOP_STATUS_MAP[data.status] ?? 'unknown';
    throw new MapsClientError(code, `Google Maps status: ${data.status}`);
  }

  // Extract element (always 1x1)
  const element = data.rows?.[0]?.elements?.[0];
  if (!element) {
    throw new MapsClientError('unknown', 'Unexpected response shape');
  }

  // Check element-level status
  if (element.status !== 'OK') {
    const code: MapsClientErrorCode =
      ELEMENT_STATUS_MAP[element.status] ?? 'unknown';
    throw new MapsClientError(
      code,
      `Google Maps element status: ${element.status}`,
    );
  }

  // Use duration_in_traffic for driving when available
  const hasTraffic =
    mode === 'driving' && element.duration_in_traffic !== undefined;
  const durationData = hasTraffic
    ? element.duration_in_traffic!
    : element.duration!;
  const distanceData = element.distance!;

  return {
    duration_seconds: durationData.value,
    distance_meters: distanceData.value,
    duration_text: durationData.text,
    distance_text: distanceData.text,
    origin_resolved: data.origin_addresses[0] ?? opts.origin,
    destination_resolved: data.destination_addresses[0] ?? opts.destination,
    mode,
    used_traffic: hasTraffic,
  };
}
