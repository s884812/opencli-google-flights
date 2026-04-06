import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ArgumentError, CliError, EmptyResultError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { CDPBridge } from '../../node_modules/@jackwener/opencli/dist/browser/cdp.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  extractFlights,
  extractFlightsFromShoppingResultsBody,
  extractStructuredShoppingResultOffers,
  extractTitle,
  fetchHtml,
} from './shared.js';

const SEED_SEARCH_URL = 'https://www.google.com/travel/flights?hl=en';
const DEFAULT_CDP_HOST = '127.0.0.1';
const AUTOCOMPLETE_WAIT_MS = 1500;
const UI_SETTLE_MS = 800;
const URL_WAIT_MS = 20000;
const URL_STABLE_MS = 2000;
const MIN_POST_EDIT_WAIT_MS = 3000;
const INPUT_WAIT_MS = 12000;
const MAX_MULTI_CITY_SEGMENTS = 6;
const MAX_DATE_ADVANCE_STEPS = 36;
const COMBINED_STEP_WAIT_MS = 60000;
const SHOPPING_REPLAY_TIMEOUT_MS = 20000;
const SEARCH_VIEWPORT = {
  width: 1440,
  height: 2200,
  deviceScaleFactor: 1,
  mobile: false,
};
const DEBUG_GOOGLE_FLIGHTS = process.env.OPENCLI_DEBUG_GOOGLE_FLIGHTS === '1';
const ORIGIN_LABELS = ['Where from?', 'Where from? '];
const DESTINATION_LABELS = ['Where to?', 'Where to? '];
const DEPARTURE_LABELS = ['Departure'];
const RETURN_LABELS = ['Return'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function debugLog(...args) {
  if (!DEBUG_GOOGLE_FLIGHTS) return;
  console.error('[google-flights]', ...args);
}

function trimValue(value) {
  return String(value || '').trim();
}

function assertIsoDate(value, label) {
  const normalized = trimValue(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ArgumentError(`${label} must use YYYY-MM-DD format`);
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new ArgumentError(`${label} must be a real calendar date`);
  }

  return normalized;
}

function formatAriaDate(isoDate) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatInputDate(isoDate) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function parseMultiCitySegments(raw) {
  const items = trimValue(raw)
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  if (items.length < 2) {
    throw new ArgumentError('Multi-city search requires at least 2 segments');
  }
  if (items.length > MAX_MULTI_CITY_SEGMENTS) {
    throw new ArgumentError(`Multi-city search supports at most ${MAX_MULTI_CITY_SEGMENTS} segments`);
  }

  return items.map((item, index) => {
    const match = item.match(/^(.+?)\s*(?:->|>)\s*(.+?)\s*@\s*(\d{4}-\d{2}-\d{2})$/);
    if (!match) {
      throw new ArgumentError(
        `Invalid segment ${index + 1}. Use "Origin>Destination@YYYY-MM-DD", for example "Tokyo>Sapporo@2026-04-16"`
      );
    }

    const [, originRaw, destinationRaw, dateRaw] = match;
    const origin = trimValue(originRaw);
    const destination = trimValue(destinationRaw);
    if (!origin || !destination) {
      throw new ArgumentError(`Segment ${index + 1} must include both origin and destination`);
    }

    return {
      origin,
      destination,
      date: assertIsoDate(dateRaw, `segment ${index + 1} date`),
    };
  });
}

function resolveItinerary(kwargs) {
  const segmentsRaw = trimValue(kwargs.segments);
  const origin = trimValue(kwargs.from);
  const destination = trimValue(kwargs.to);
  const depart = trimValue(kwargs.depart);
  const returnDate = trimValue(kwargs.return);

  if (segmentsRaw) {
    if (origin || destination || depart || returnDate) {
      throw new ArgumentError('Use either --segments for multi-city or --from/--to/--depart/--return for single-trip searches');
    }

    return {
      tripType: 'multi-city',
      segments: parseMultiCitySegments(segmentsRaw),
    };
  }

  if (!origin || !destination || !depart) {
    throw new ArgumentError('Provide --from, --to, and --depart, or use --segments for multi-city searches');
  }

  const outbound = {
    origin,
    destination,
    date: assertIsoDate(depart, 'depart'),
  };

  if (!returnDate) {
    return {
      tripType: 'one-way',
      segments: [outbound],
    };
  }

  const inboundDate = assertIsoDate(returnDate, 'return');
  if (inboundDate < outbound.date) {
    throw new ArgumentError('return date cannot be earlier than depart date');
  }

  return {
    tripType: 'round-trip',
    segments: [outbound],
    returnDate: inboundDate,
  };
}

function formatSegmentRoute(segment) {
  return `${segment.origin} -> ${segment.destination}`;
}

function formatDisplayPrice(priceValue) {
  if (!Number.isFinite(priceValue)) return '';
  return new Intl.NumberFormat('en-US').format(priceValue);
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function encodeVarint(value) {
  let remaining = Number(value);
  const bytes = [];
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return bytes;
}

function encodeVarintField(fieldNumber, value) {
  return [
    ...encodeVarint((fieldNumber << 3) | 0),
    ...encodeVarint(value),
  ];
}

function encodeLengthDelimitedField(fieldNumber, bytes) {
  return [
    ...encodeVarint((fieldNumber << 3) | 2),
    ...encodeVarint(bytes.length),
    ...bytes,
  ];
}

function encodeStringField(fieldNumber, value) {
  return encodeLengthDelimitedField(fieldNumber, [...Buffer.from(String(value || ''), 'utf8')]);
}

function encodeAirportRef(code) {
  return [
    ...encodeVarintField(1, 1),
    ...encodeStringField(2, trimValue(code).toUpperCase()),
  ];
}

function encodeMultiCitySegment(segment) {
  return [
    ...encodeStringField(2, segment.date),
    ...encodeLengthDelimitedField(13, encodeAirportRef(segment.origin)),
    ...encodeLengthDelimitedField(14, encodeAirportRef(segment.destination)),
  ];
}

function encodeUrlSafeBase64(bytes) {
  return Buffer.from(Uint8Array.from(bytes))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildMultiCityTfs(itinerary) {
  const bytes = [
    ...encodeVarintField(1, 28),
    ...encodeVarintField(2, 2),
  ];

  for (const segment of itinerary.segments) {
    bytes.push(...encodeLengthDelimitedField(3, encodeMultiCitySegment(segment)));
  }

  bytes.push(
    ...encodeVarintField(8, 1),
    ...encodeVarintField(9, 1),
    ...encodeVarintField(14, 1),
    ...encodeLengthDelimitedField(16, [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    ...encodeVarintField(19, 3),
  );

  return encodeUrlSafeBase64(bytes);
}

function buildSegmentedSearchUrl(segments) {
  const params = new URLSearchParams({
    tfs: buildMultiCityTfs({ segments }),
    hl: 'en',
  });
  return `https://www.google.com/travel/flights/search?${params.toString()}`;
}

function buildMultiCitySearchUrl(itinerary) {
  return buildSegmentedSearchUrl(itinerary.segments || []);
}

function isAirportCodeToken(value) {
  return /^[A-Za-z]{3}$/.test(trimValue(value));
}

function monthNameToNumber(value) {
  const normalized = trimValue(value).toLowerCase();
  const months = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  return months[normalized] || 0;
}

function inferIsoDateFromMonthDay(label, anchorIsoDate) {
  const match = normalizeWhitespace(label).match(/^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return '';

  const [, monthName, dayRaw] = match;
  const month = monthNameToNumber(monthName);
  const day = Number(dayRaw);
  if (!month || !Number.isInteger(day)) return '';

  const anchor = new Date(`${anchorIsoDate}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return '';

  const anchorMonth = anchor.getUTCMonth() + 1;
  let year = anchor.getUTCFullYear();
  if (month < anchorMonth - 6) year += 1;
  if (month > anchorMonth + 6) year -= 1;

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function formatCandidateDateTime(anchorIsoDate, timeText, dateLabel) {
  const date = inferIsoDateFromMonthDay(dateLabel, anchorIsoDate) || anchorIsoDate;
  const time = trimValue(timeText);
  return [date, time].filter(Boolean).join(' ');
}

function expandOutputSegments(itinerary) {
  if (itinerary.tripType !== 'round-trip') {
    return itinerary.segments;
  }

  const [outbound] = itinerary.segments;
  if (!outbound || !itinerary.returnDate) {
    return itinerary.segments;
  }

  return [
    outbound,
    {
      origin: outbound.destination,
      destination: outbound.origin,
      date: itinerary.returnDate,
    },
  ];
}

function resolveMultiCitySegmentIndexByTitle(itinerary, title) {
  if (itinerary.tripType !== 'multi-city') return null;

  const normalizedTitle = trimValue(title.split('|')[0] || title).replace(/\s+/g, ' ').toLowerCase();
  if (!normalizedTitle) return 0;

  const matchedIndex = itinerary.segments.findIndex((segment) => (
    normalizedTitle.includes(trimValue(segment.origin).replace(/\s+/g, ' ').toLowerCase())
    && normalizedTitle.includes(trimValue(segment.destination).replace(/\s+/g, ' ').toLowerCase())
  ));

  return matchedIndex >= 0 ? matchedIndex : 0;
}

function annotateFlightsForSegment(flights, segment, segmentIndex) {
  if (!segment) return flights;
  return flights.map((flight) => ({
    ...flight,
    segment_index: segmentIndex + 1,
    segment_route: formatSegmentRoute(segment),
  }));
}

function decorateFlights(flights, searchUrl, tripType) {
  return flights.map((flight) => ({
    ...flight,
    search_url: searchUrl,
    trip_type: tripType,
  }));
}

function filterShoppingResultEntries(entries) {
  return entries.filter((entry) => (
    entry.url
    && entry.method === 'POST'
    && (entry.postData || entry.hasPostData)
  ));
}

function filterShoppingResultBodies(entries) {
  return entries
    .filter((entry) => entry.status === 200 && entry.responseBody && !entry.base64Encoded)
    .map((entry) => entry.responseBody);
}

function extractShoppingFlights(shoppingResults, limit) {
  return [...shoppingResults]
    .reverse()
    .map((body) => extractFlightsFromShoppingResultsBody(body, limit))
    .find((items) => items.length)
    || [];
}

function formatIsoDateFromParts(parts) {
  if (!Array.isArray(parts) || parts.length < 3) return '';
  const [year, month, day] = parts;
  if (![year, month, day].every((value) => Number.isInteger(value) && value > 0)) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildSelectionKeysFromShoppingOffer(offer) {
  const row = offer?.[0];
  const segments = Array.isArray(row?.[2]) ? row[2].filter(Array.isArray) : [];
  return segments
    .map((segment) => {
      const origin = trimValue(segment?.[3]);
      const destination = trimValue(segment?.[6]);
      const date = formatIsoDateFromParts(segment?.[20] || row?.[4]);
      const airlineCode = trimValue(segment?.[22]?.[0]);
      const flightNumber = trimValue(segment?.[22]?.[1]);
      if (!origin || !destination || !date || (!airlineCode && !flightNumber)) return null;
      return [origin, date, destination, null, airlineCode || null, flightNumber || null];
    })
    .filter(Boolean);
}

function summarizeShoppingInner(inner) {
  const root = Array.isArray(inner?.[0]) ? inner[0] : [];
  const segmentEntries = Array.isArray(inner?.[1]?.[13]) ? inner[1][13] : [];
  return {
    rootLength: root.length,
    root0: trimValue(root[0]),
    root1: trimValue(root[1]),
    root2: trimValue(root[2]),
    root3: trimValue(root[3]),
    segmentSelectionCounts: segmentEntries.map((entry) => {
      const keys = Array.isArray(entry?.[8]) ? entry[8] : [];
      return keys.length;
    }),
    segmentSelections: segmentEntries.map((entry) => {
      const keys = Array.isArray(entry?.[8]) ? entry[8] : [];
      return keys.map((key) => Array.isArray(key) ? key.join('|') : String(key || ''));
    }),
  };
}

function parseShoppingRequestEntry(entry) {
  try {
    const params = new URLSearchParams(entry.postData || '');
    const fReq = params.get('f.req');
    if (!fReq) return null;
    const outer = JSON.parse(fReq);
    const inner = JSON.parse(outer?.[1] || 'null');
    if (!Array.isArray(inner)) return null;
    return {
      url: entry.url,
      rawPostData: entry.postData || '',
      params,
      outer,
      inner,
    };
  } catch {
    return null;
  }
}

function buildShoppingRequestPostData(parsedRequest, inner) {
  const outer = Array.isArray(parsedRequest.outer) ? [...parsedRequest.outer] : [null, ''];
  outer[1] = JSON.stringify(inner);
  const nextFReq = JSON.stringify(outer);
  const rawPostData = trimValue(parsedRequest.rawPostData || '');

  if (rawPostData) {
    const encodedFReq = encodeURIComponent(nextFReq);
    const parts = rawPostData.split('&');
    let replaced = false;
    const rebuilt = parts.map((part) => {
      if (!part.startsWith('f.req=')) return part;
      replaced = true;
      return `f.req=${encodedFReq}`;
    });
    if (replaced) {
      return rebuilt.join('&');
    }
  }

  const params = new URLSearchParams(parsedRequest.params.toString());
  params.set('f.req', nextFReq);
  return params.toString();
}

async function replayShoppingResultsRequest(page, parsedRequest, inner, rawPostData = '') {
  debugLog('replayShoppingResultsRequest:start', {
    url: parsedRequest?.url || '',
    hasRawPostData: Boolean(rawPostData),
    inner0Length: Array.isArray(inner?.[0]) ? inner[0].length : null,
  });
  const result = await pageEval(
    page,
    `(() => {
      const url = ${JSON.stringify(parsedRequest.url)};
      const body = ${JSON.stringify(rawPostData || buildShoppingRequestPostData(parsedRequest, inner))};
      const timeoutMs = ${JSON.stringify(SHOPPING_REPLAY_TIMEOUT_MS)};
      return (async () => {
        return await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          const timeout = setTimeout(() => {
            try {
              xhr.abort();
            } catch {}
            resolve({ ok: false, status: 0, error: 'AbortError: timeout' });
          }, timeoutMs);

          xhr.open('POST', url, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
          xhr.setRequestHeader('x-same-domain', '1');
          xhr.setRequestHeader('accept', '*/*');

          xhr.onreadystatechange = () => {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            clearTimeout(timeout);
            resolve({
              ok: xhr.status >= 200 && xhr.status < 300,
              status: xhr.status,
              body: xhr.responseText || '',
            });
          };

          xhr.onerror = () => {
            clearTimeout(timeout);
            resolve({ ok: false, status: xhr.status || 0, error: 'NetworkError' });
          };

          try {
            xhr.send(body);
          } catch (error) {
            clearTimeout(timeout);
            resolve({ ok: false, status: 0, error: String(error) });
          }
        });
      })();
    })()`
  );

  if (result?.error) {
    debugLog('replayShoppingResultsRequest:error', {
      status: result?.status || 0,
      error: result?.error || '',
      inner: summarizeShoppingInner(inner),
    });
    if (/AbortError/i.test(result.error)) {
      throw new CliError(
        'TIMEOUT_ERROR',
        'Google Flights shopping replay timed out',
        'Retry the search; Google may be throttling the current shopping session'
      );
    }
    throw new CliError(
      'FETCH_ERROR',
      `Google Flights shopping replay failed (${result.error})`,
      'Retry the search; Google may have invalidated the current shopping session'
    );
  }

  if (!result?.ok) {
    debugLog('replayShoppingResultsRequest:notOk', {
      status: result?.status || 0,
      bodyLength: String(result?.body || '').length,
      inner: summarizeShoppingInner(inner),
    });
    throw new CliError(
      'FETCH_ERROR',
      `Google Flights shopping replay failed with status ${result?.status || 0}`,
      'Retry the search; Google may have invalidated the current shopping session'
    );
  }

  debugLog('replayShoppingResultsRequest:done', {
    status: result?.status || 0,
    bodyLength: String(result.body || '').length,
  });
  return String(result.body || '');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function annotateCombinedSegmentOffer(parsed, segment, segmentIndex) {
  return {
    ...parsed,
    rank: segmentIndex + 1,
    segment_index: segmentIndex + 1,
    segment_route: formatSegmentRoute(segment),
  };
}

function buildCombinedBundleFromSelectedOffers(itinerary, searchUrl, title, selectedOffers) {
  const lastOffer = selectedOffers[selectedOffers.length - 1] || {};
  const bundle = {
    booking_url: '',
    search_url: searchUrl,
    title,
    trip_type: itinerary.tripType,
    price: lastOffer.price || '',
    price_value: lastOffer.price_value,
    booking_provider: '',
    booking_options: [],
    separate_tickets: selectedOffers.some((segment) => segment.separate_tickets),
    segments: selectedOffers.map((segment, index) => ({
      ...segment,
      rank: index + 1,
      segment_index: index + 1,
    })),
  };
  bundle.summary = buildCombinedBundleSummary(bundle);
  return bundle;
}

function buildApiPayload(itinerary, searchUrl, title, flights, options = {}) {
  const pricingMode = trimValue(options.pricingMode || (itinerary.tripType === 'multi-city' ? 'separate' : 'standard'));
  const outputSegments = expandOutputSegments(itinerary);
  const activeSegmentIndex = Number.isInteger(options.activeSegmentIndex)
    ? options.activeSegmentIndex
    : resolveMultiCitySegmentIndexByTitle(itinerary, title);
  const activeSegment = outputSegments[activeSegmentIndex] || outputSegments[0] || null;
  const querySegments = outputSegments.map((segment, index) => ({
    segment_index: index + 1,
    route: formatSegmentRoute(segment),
    origin: segment.origin,
    destination: segment.destination,
    date: segment.date,
  }));
  const searchUrls = [...new Set(flights.map((flight) => trimValue(flight.search_url)).filter(Boolean))];

  const payload = {
    trip_type: itinerary.tripType,
    pricing_mode: pricingMode,
    search_url: itinerary.tripType === 'multi-city' ? (searchUrls[0] || searchUrl) : searchUrl,
    title,
    total_flights: flights.length,
    query: {
      segments: querySegments,
    },
    flights,
  };

  if (itinerary.tripType !== 'multi-city') {
    const [segment] = itinerary.segments;
    payload.query.from = segment?.origin || '';
    payload.query.to = segment?.destination || '';
    payload.query.depart = segment?.date || '';
  }

  if (itinerary.returnDate) {
    payload.query.return = itinerary.returnDate;
  }

  if (itinerary.tripType === 'round-trip' || itinerary.tripType === 'multi-city') {
    payload.results_scope = 'per-segment';
    payload.segments = querySegments.map((segment) => ({
      ...segment,
      search_url: flights.find((flight) => flight.segment_index === segment.segment_index)?.search_url || '',
      flights: flights.filter((flight) => flight.segment_index === segment.segment_index),
    }));
  }

  if (options.activeStepFlights?.length) {
    payload.active_step_index = activeSegment ? activeSegmentIndex + 1 : null;
    payload.active_step_route = activeSegment ? formatSegmentRoute(activeSegment) : '';
    payload.active_step_scope = trimValue(options.activeStepScope || 'google-active-segment');
    payload.active_step_flights = options.activeStepFlights;
  }

  if (itinerary.tripType === 'multi-city') {
    payload.search_urls = searchUrls;
    payload.active_segment_index = activeSegment ? activeSegmentIndex + 1 : null;
    payload.active_segment_route = activeSegment ? formatSegmentRoute(activeSegment) : '';
    if (!options.activeStepFlights?.length) {
      payload.results_scope = pricingMode === 'combined' ? 'google-active-segment' : 'per-segment';
    }
  }

  return payload;
}

function parseCombinedOfferAria(ariaLabel, segment, optionIndex) {
  const aria = normalizeWhitespace(ariaLabel);
  const match = aria.match(
    /^From\s+(\d+)\s+Japanese yen\s+(.+?)\.\s+(.+?) flight with\s+(.+?)\.\s+Leaves\s+(.+?)\s+at\s+(.+?)\s+on\s+(.+?)\s+and arrives at\s+(.+?)\s+at\s+(.+?)\s+on\s+(.+?)\.\s+Total duration\s+(.+?)\.\s*(.*?)\s*Select flight$/i
  );

  if (!match) {
    return {
      rank: optionIndex + 1,
      option_index: optionIndex,
      segment_index: null,
      segment_route: segment ? formatSegmentRoute(segment) : '',
      price: '',
      price_value: NaN,
      airline: '',
      flight_number: '',
      stops: '',
      depart: segment?.date || '',
      arrive: segment?.date || '',
      duration: '',
      from_airport: segment?.origin || '',
      to_airport: segment?.destination || '',
      separate_tickets: /separate tickets/i.test(aria),
      raw_aria: aria,
      summary: aria,
    };
  }

  const [
    ,
    priceRaw,
    pricingLabelRaw,
    stopLabelRaw,
    airlineRaw,
    fromAirportRaw,
    departTimeRaw,
    departDateRaw,
    toAirportRaw,
    arriveTimeRaw,
    arriveDateRaw,
    durationRaw,
    tailRaw,
  ] = match;

  const priceValue = Number(priceRaw);
  const pricingLabel = normalizeWhitespace(pricingLabelRaw);
  const stopLabel = normalizeWhitespace(stopLabelRaw).toLowerCase();
  const airline = normalizeWhitespace(airlineRaw);
  const fromAirport = normalizeWhitespace(fromAirportRaw);
  const toAirport = normalizeWhitespace(toAirportRaw);
  const depart = formatCandidateDateTime(segment?.date || '', departTimeRaw, departDateRaw);
  const arrive = formatCandidateDateTime(segment?.date || '', arriveTimeRaw, arriveDateRaw);
  const duration = normalizeWhitespace(durationRaw);
  const tail = normalizeWhitespace(tailRaw);
  const separateTickets = /separate tickets/i.test(tail);
  const stops = stopLabel === 'nonstop' ? 'nonstop' : stopLabel;
  const summary = [
    segment ? formatSegmentRoute(segment) : '',
    airline,
    stops,
    pricingLabel,
    formatDisplayPrice(priceValue) && `price ${formatDisplayPrice(priceValue)}`,
    separateTickets ? 'separate tickets' : '',
  ].filter(Boolean).join(' | ');

  return {
    rank: optionIndex + 1,
    option_index: optionIndex,
    segment_index: null,
    segment_route: segment ? formatSegmentRoute(segment) : '',
    price: formatDisplayPrice(priceValue),
    price_value: priceValue,
    airline,
    flight_number: '',
    stops,
    depart,
    arrive,
    duration,
    from_airport: fromAirport,
    to_airport: toAirport,
    pricing_label: pricingLabel,
    separate_tickets: separateTickets,
    raw_aria: aria,
    summary,
  };
}

function parseContinueButtonAria(ariaLabel) {
  const aria = normalizeWhitespace(ariaLabel);
  const match = aria.match(/^Continue to book with\s+(.+?)\s+for\s+(\d+)\s+Japanese yen\.?\s*(.*)$/i);
  if (!match) {
    return {
      provider: '',
      price: '',
      price_value: NaN,
      separate_tickets: /separately|individually|separate tickets/i.test(aria),
      raw_aria: aria,
    };
  }

  const [, providerRaw, priceRaw, tailRaw] = match;
  const provider = normalizeWhitespace(providerRaw).replace(/\s+airline$/i, '');
  const priceValue = Number(priceRaw);
  return {
    provider,
    price: formatDisplayPrice(priceValue),
    price_value: priceValue,
    separate_tickets: /separately|individually|separate tickets/i.test(tailRaw),
    raw_aria: aria,
    note: normalizeWhitespace(tailRaw),
  };
}

function buildCombinedBundleSummary(bundle) {
  return [
    bundle.price && `total ${bundle.price}`,
    bundle.booking_provider && `book with ${bundle.booking_provider}`,
    bundle.separate_tickets ? 'separate tickets' : '',
    bundle.segments?.map(segment => `${segment.segment_route} ${segment.airline} ${segment.depart} -> ${segment.arrive}`).join(' | '),
  ].filter(Boolean).join(' | ');
}

function buildCombinedBundleRow(bundle, rank) {
  const segments = bundle.segments || [];
  const firstSegment = segments[0] || {};
  const lastSegment = segments[segments.length - 1] || firstSegment;
  const airlines = [...new Set(segments.map(segment => trimValue(segment.airline)).filter(Boolean))].join(', ');
  const stops = segments.map(segment => trimValue(segment.stops)).filter(Boolean).join(' / ');

  return {
    rank,
    price: bundle.price,
    price_value: bundle.price_value,
    airline: airlines,
    flight_number: segments.map(segment => trimValue(segment.flight_number)).filter(Boolean).join(' | '),
    stops,
    depart: firstSegment.depart || '',
    arrive: lastSegment.arrive || '',
    duration: '',
    from_airport: firstSegment.from_airport || '',
    to_airport: lastSegment.to_airport || '',
    segment_route: segments.map(segment => trimValue(segment.segment_route)).filter(Boolean).join(' | '),
    booking_provider: bundle.booking_provider || '',
    booking_url: bundle.booking_url || '',
    separate_tickets: bundle.separate_tickets,
    summary: bundle.summary || buildCombinedBundleSummary(bundle),
    search_url: bundle.booking_url || bundle.search_url || '',
    trip_type: bundle.trip_type || '',
    segments,
  };
}

function buildCombinedApiPayload(itinerary, searchUrl, title, bundles, rows, options = {}) {
  const outputSegments = expandOutputSegments(itinerary);
  const querySegments = outputSegments.map((segment, index) => ({
    segment_index: index + 1,
    route: formatSegmentRoute(segment),
    origin: segment.origin,
    destination: segment.destination,
    date: segment.date,
  }));

  return {
    trip_type: itinerary.tripType,
    pricing_mode: trimValue(options.pricingMode || 'combined'),
    results_scope: 'combined-bundles',
    search_url: searchUrl,
    title,
    total_flights: rows.length,
    total_bundles: bundles.length,
    query: {
      segments: querySegments,
      ...(itinerary.tripType !== 'multi-city'
        ? {
          from: outputSegments[0]?.origin || '',
          to: outputSegments[0]?.destination || '',
          depart: outputSegments[0]?.date || '',
        }
        : {}),
      ...(itinerary.returnDate ? { return: itinerary.returnDate } : {}),
    },
    flights: rows,
    bundles,
    segments: querySegments,
    combined_branch_width: options.branchWidth || 0,
  };
}

async function collectFlightsForSegments(segments, endpoint, outputTripType, limit) {
  const finalFlights = [];
  let title = '';
  let searchUrl = '';

  for (const [index, segment] of segments.entries()) {
    const segmentItinerary = {
      tripType: 'one-way',
      segments: [segment],
    };
    const segmentResult = await collectFlightsForItinerary(
      segmentItinerary,
      endpoint,
      outputTripType,
      limit
    );

    if (!title) title = segmentResult.title;
    if (!searchUrl) searchUrl = segmentResult.searchUrl;

    finalFlights.push(
      ...annotateFlightsForSegment(segmentResult.flights, segment, index)
    );
  }

  return { title, searchUrl, flights: finalFlights };
}

function resolveCombinedBranchWidth(limit, segmentCount) {
  if (segmentCount >= 5) return 2;
  if (segmentCount >= 4) return 2;
  return Math.max(2, Math.min(4, limit));
}

async function inspectCombinedPageState(page) {
  return pageEval(
    page,
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const dedupeByAria = (elements) => {
        const seen = new Set();
        return elements.filter((el) => {
          const aria = normalize(el.getAttribute('aria-label') || '');
          if (!aria || seen.has(aria)) return false;
          seen.add(aria);
          return true;
        });
      };
      const selectableFlights = dedupeByAria(Array.from(document.querySelectorAll('[role="link"], button, [role="button"], [aria-label]'))
        .filter((el) => visible(el) && /select flight/i.test(normalize(el.getAttribute('aria-label') || ''))))
        .map((el, optionIndex) => ({
          option_index: optionIndex,
          aria: normalize(el.getAttribute('aria-label') || ''),
          text: normalize(el.innerText || el.textContent || ''),
        }));
      const continueButtons = Array.from(document.querySelectorAll('button'))
        .filter((el) => visible(el) && /continue to book/i.test(normalize(el.getAttribute('aria-label') || '')))
        .map((el) => ({
          aria: normalize(el.getAttribute('aria-label') || ''),
          text: normalize(el.innerText || el.textContent || ''),
        }));
      const reloadButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((el) => visible(el) && normalize(el.innerText || el.textContent || '') === 'Reload')
        .map((el) => ({
          aria: normalize(el.getAttribute('aria-label') || ''),
          text: normalize(el.innerText || el.textContent || ''),
        }));
      const loading = Array.from(document.querySelectorAll('[role="progressbar"]'))
        .some((el) => visible(el) && /loading/i.test(normalize(el.getAttribute('aria-label') || el.innerText || el.textContent || '')));
      const bodyText = normalize(document.body?.innerText || '').slice(0, 4000);
      return {
        title: document.title,
        url: location.href,
        loading,
        selectableFlights,
        continueButtons,
        reloadButtons,
        dateDialogOpen: /enter a date or use the arrow keys/i.test(bodyText),
        noResultsError: /no results returned|oops, something went wrong/i.test(bodyText),
        bodyText,
      };
    })()`
  );
}

async function waitForCombinedPageState(page, bridge, previousUrl = '') {
  const deadline = Date.now() + COMBINED_STEP_WAIT_MS;
  let lastState = await inspectCombinedPageState(page);
  let attemptedReload = false;
  let attemptedLoadingRefresh = false;

  while (Date.now() < deadline) {
    lastState = await inspectCombinedPageState(page);
    const hasResults = lastState.selectableFlights.length > 0 || lastState.continueButtons.length > 0;

    if (trimValue(lastState.url).includes('/travel/flights/booking')) {
      return lastState;
    }

    if (lastState.dateDialogOpen && !lastState.continueButtons.length) {
      const dismissed = await dismissDatePickerIfPresent(bridge, page);
      await sleep(1000);
      if (!hasResults || dismissed) {
        continue;
      }
    }

    if (hasResults && (!previousUrl || lastState.url !== previousUrl || lastState.continueButtons.length > 0)) {
      return lastState;
    }

    if (!attemptedReload && lastState.noResultsError && lastState.reloadButtons.length > 0) {
      attemptedReload = true;
      await clickVisibleText(page, 'Reload').catch(() => {});
      await sleep(2500);
      continue;
    }

    if (
      !attemptedLoadingRefresh
      && trimValue(lastState.url).includes('tfu=')
      && /loading results/i.test(lastState.bodyText)
    ) {
      attemptedLoadingRefresh = true;
      await page.goto(lastState.url).catch(() => {});
      await sleep(2500);
      continue;
    }

    await sleep(500);
  }

  throw new CliError(
    'TIMEOUT_ERROR',
    `Google Flights combined flow did not reach a selectable state in time${lastState?.title ? ` (${lastState.title})` : ''}`,
    'Try a smaller itinerary or verify Google Flights is still rendering live result options for this search'
  );
}

async function clickCombinedFlightOption(bridge, page, optionIndex, optionAria = '') {
  const target = await pageEval(
    page,
    `(() => {
      const optionIndex = ${JSON.stringify(optionIndex)};
      const optionAria = ${JSON.stringify(optionAria)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const dedupeByAria = (elements) => {
        const seen = new Set();
        return elements.filter((el) => {
          const aria = normalize(el.getAttribute('aria-label') || '');
          if (!aria || seen.has(aria)) return false;
          seen.add(aria);
          return true;
        });
      };
      const matches = dedupeByAria(Array.from(document.querySelectorAll('[role="link"], button, [role="button"], [aria-label]'))
        .filter((el) => visible(el) && /select flight/i.test(normalize(el.getAttribute('aria-label') || ''))));
      const target = matches.find((el) => normalize(el.getAttribute('aria-label') || '') === optionAria) || matches[optionIndex];
      if (!target) throw new Error('Combined flight option not found at index ' + optionIndex);
      target.scrollIntoView({ block: 'center' });
      const aria = normalize(target.getAttribute('aria-label') || '');
      const rect = target.getBoundingClientRect();
      return {
        aria,
        option_index: optionIndex,
        point: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
      };
    })()`
  );
  await sleep(100);
  await nativeClickPoint(bridge, target.point);
  await sleep(UI_SETTLE_MS);
  return { aria: target.aria, option_index: target.option_index };
}

async function navigateCombinedHistoryBack(page, bridge, expectedUrl = '') {
  if (expectedUrl) {
    await page.goto(expectedUrl);
    await sleep(1000);
    try {
      const state = await waitForCombinedPageState(page, bridge);
      if (state.selectableFlights.length > 0) return state;
    } catch {
      // Fall through to history navigation fallback.
    }
  }

  await pageEval(page, 'history.back()');

  const deadline = Date.now() + COMBINED_STEP_WAIT_MS;
  let lastState = await inspectCombinedPageState(page);
  while (Date.now() < deadline) {
    lastState = await inspectCombinedPageState(page);
    if (
      lastState.selectableFlights.length > 0 &&
      (!expectedUrl || lastState.url === expectedUrl || !lastState.loading)
    ) {
      return lastState;
    }
    await sleep(500);
  }

  throw new CliError(
    'TIMEOUT_ERROR',
    `Google Flights combined flow did not return to the previous selection step in time${lastState?.title ? ` (${lastState.title})` : ''}`,
    'Retry the search or reduce the number of requested bundles'
  );
}

async function extractCombinedBundleFromPage(page, itinerary, searchUrl, selectedSegments) {
  let state = await inspectCombinedPageState(page);
  if (state.url.includes('/travel/flights/booking') && state.continueButtons.length === 0) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(500);
      state = await inspectCombinedPageState(page);
      if (state.continueButtons.length > 0) break;
    }
  }
  const bookingOptions = state.continueButtons.map((item) => parseContinueButtonAria(item.aria));
  const primaryOption = bookingOptions[0] || {};
  const finalPriceValue = Number.isFinite(primaryOption.price_value)
    ? primaryOption.price_value
    : selectedSegments[selectedSegments.length - 1]?.price_value;
  const finalPrice = formatDisplayPrice(finalPriceValue);
  const separateTickets = bookingOptions.some(option => option.separate_tickets)
    || /separate tickets/i.test(state.bodyText)
    || selectedSegments.some(segment => segment.separate_tickets);

  const bundle = {
    booking_url: state.url,
    search_url: searchUrl,
    title: state.title,
    trip_type: itinerary.tripType,
    price: finalPrice,
    price_value: finalPriceValue,
    booking_provider: primaryOption.provider || '',
    booking_options: bookingOptions,
    separate_tickets: separateTickets,
    segments: selectedSegments.map((segment, index) => ({
      ...segment,
      rank: index + 1,
      segment_index: index + 1,
      segment_route: segment.segment_route || formatSegmentRoute(expandOutputSegments(itinerary)[index]),
    })),
  };

  bundle.summary = buildCombinedBundleSummary(bundle);
  return bundle;
}

function dedupeCombinedBundles(bundles) {
  const seen = new Set();
  return bundles.filter((bundle) => {
    const id = [
      trimValue(bundle.booking_url),
      bundle.segments?.map(segment => `${segment.segment_route}|${segment.depart}|${segment.arrive}|${segment.airline}`).join('||'),
    ].join('::');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function exploreCombinedBundles(page, bridge, itinerary, searchUrl, outputSegments, depth, branchWidth, path, bundles, maxBundles) {
  const currentState = await waitForCombinedPageState(page, bridge);
  const offers = currentState.selectableFlights
    .slice(0, branchWidth)
    .map((item) => parseCombinedOfferAria(item.aria, outputSegments[depth], item.option_index));

  for (const offer of offers) {
    if (bundles.length >= maxBundles) break;

    const previousUrl = trimValue(currentState.url);
    const clicked = await clickCombinedFlightOption(bridge, page, offer.option_index, offer.raw_aria || offer.summary || offer.price || '');
    const nextState = await waitForCombinedPageState(page, bridge, previousUrl);
    const nextPath = [...path, { ...offer, raw_aria: clicked.aria }];

    if (depth === outputSegments.length - 1 || nextState.continueButtons.length) {
      bundles.push(await extractCombinedBundleFromPage(page, itinerary, searchUrl, nextPath));
    } else {
      await exploreCombinedBundles(page, bridge, itinerary, searchUrl, outputSegments, depth + 1, branchWidth, nextPath, bundles, maxBundles);
    }

    if (bundles.length >= maxBundles) break;
    await navigateCombinedHistoryBack(page, bridge, previousUrl);
  }
}

async function exploreCombinedBundlesViaApi(page, parsedRequest, inner, itinerary, searchUrl, title, outputSegments, depth, branchWidth, path, bundles, maxBundles, cachedBody = '') {
  if (bundles.length >= maxBundles) return;

  let responseBody = cachedBody;
  if (!responseBody) {
    try {
      responseBody = await replayShoppingResultsRequest(page, parsedRequest, inner);
    } catch (error) {
      debugLog('exploreCombinedBundlesViaApi:replayFailed', {
        depth,
        error: error instanceof Error ? error.message : String(error),
        inner: summarizeShoppingInner(inner),
      });
      return;
    }
  }
  const offers = extractStructuredShoppingResultOffers(responseBody, branchWidth).slice(0, branchWidth);
  debugLog('exploreCombinedBundlesViaApi:offers', {
    depth,
    offers: offers.length,
    branchWidth,
    cachedBody: Boolean(cachedBody),
  });
  if (!offers.length) return;

  for (const item of offers) {
    if (bundles.length >= maxBundles) break;

    const segment = outputSegments[depth];
    const annotatedOffer = annotateCombinedSegmentOffer(item.parsed, segment, depth);
    const nextPath = [...path, annotatedOffer];

    if (depth === outputSegments.length - 1) {
      bundles.push(buildCombinedBundleFromSelectedOffers(itinerary, searchUrl, title, nextPath));
      continue;
    }

    const nextInner = cloneJson(inner);
    if (Array.isArray(nextInner?.[0]) && typeof item.offer?.[1]?.[1] === 'string') {
      if (nextInner[0].length >= 4) {
        if (!trimValue(nextInner[0][3]) || depth === 0) {
          nextInner[0][3] = item.offer[1][1];
        }
      } else if (nextInner[0].length >= 2) {
        if (!trimValue(nextInner[0][1]) || depth === 0) {
          nextInner[0][1] = item.offer[1][1];
        }
      }
    }

    const segmentPayload = nextInner?.[1]?.[13]?.[depth];
    if (Array.isArray(segmentPayload)) {
      segmentPayload[8] = buildSelectionKeysFromShoppingOffer(item.offer);
    }

    debugLog('exploreCombinedBundlesViaApi:nextInner', {
      depth,
      nextDepth: depth + 1,
      offerPrice: annotatedOffer.price,
      offerFlights: annotatedOffer.flight_number,
      selectionToken: trimValue(item.offer?.[1]?.[1]),
      inner: summarizeShoppingInner(nextInner),
    });

    await exploreCombinedBundlesViaApi(
      page,
      parsedRequest,
      nextInner,
      itinerary,
      searchUrl,
      title,
      outputSegments,
      depth + 1,
      branchWidth,
      nextPath,
      bundles,
      maxBundles
    ).catch(() => {});
  }
}

async function canConnectToCdp(endpoint, timeoutSeconds = 5) {
  const bridge = new CDPBridge();
  try {
    await bridge.connect({ cdpEndpoint: endpoint, timeout: timeoutSeconds });
    return true;
  } catch {
    return false;
  } finally {
    await bridge.close().catch(() => {});
  }
}

async function findChromeExecutable() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function waitForCdp(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToCdp(endpoint, 3)) return;
    await sleep(500);
  }

  throw new CliError(
    'BROWSER_CONNECT_ERROR',
    'Timed out starting headless Chrome for Google Flights search',
    'Set OPENCLI_CDP_ENDPOINT to a running Chrome DevTools endpoint and retry'
  );
}

async function allocateCdpPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, DEFAULT_CDP_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine a free CDP port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function ensureCdpEndpoint() {
  const envEndpoint = trimValue(process.env.OPENCLI_CDP_ENDPOINT);
  if (envEndpoint) {
    if (await canConnectToCdp(envEndpoint, 5)) {
      return { endpoint: envEndpoint, cleanup: async () => {} };
    }

    throw new CliError(
      'BROWSER_CONNECT_ERROR',
      `Could not connect to OPENCLI_CDP_ENDPOINT (${envEndpoint})`,
      'Start Chrome with remote debugging enabled, or unset OPENCLI_CDP_ENDPOINT to let this command launch headless Chrome automatically'
    );
  }

  const chromePath = await findChromeExecutable();
  if (!chromePath) {
    throw new CliError(
      'BROWSER_CONNECT_ERROR',
      'Google Chrome executable was not found',
      'Install Google Chrome or set OPENCLI_CDP_ENDPOINT to a running Chrome DevTools endpoint'
    );
  }

  const cdpPort = await allocateCdpPort();
  const endpoint = `http://${DEFAULT_CDP_HOST}:${cdpPort}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'opencli-google-flights-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      `--remote-debugging-address=${DEFAULT_CDP_HOST}`,
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  chrome.unref();

  await waitForCdp(endpoint, 15000);

  return {
    endpoint,
    cleanup: async () => {
      chrome.kill('SIGTERM');
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function pageEval(page, code) {
  return page.evaluate(code);
}

async function startNetworkCapture(bridge, pattern) {
  const requests = new Map();
  const order = [];
  const pending = new Set();

  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  };

  const fillRequestPostData = async (requestId) => {
    const entry = requests.get(requestId);
    if (!entry || entry.postData) return;
    try {
      const payload = await bridge.send('Network.getRequestPostData', { requestId });
      entry.postData = payload?.postData || entry.postData || '';
    } catch (error) {
      entry.postDataError = String(error);
    }
  };

  const onRequest = (params) => {
    const url = params.request?.url || '';
    if (!url.includes(pattern)) return;
    if (!requests.has(params.requestId)) order.push(params.requestId);
    requests.set(params.requestId, {
      requestId: params.requestId,
      url,
      method: params.request?.method || '',
      postData: params.request?.postData || '',
      hasPostData: params.request?.hasPostData === true || !!params.request?.postData,
    });
    if (!params.request?.postData && params.request?.hasPostData) {
      track(fillRequestPostData(params.requestId));
    }
  };

  const onResponse = (params) => {
    const entry = requests.get(params.requestId);
    if (!entry) return;
    entry.status = params.response?.status || 0;
    entry.mimeType = params.response?.mimeType || '';
  };

  const onFinished = async (params) => {
    const entry = requests.get(params.requestId);
    if (!entry) return;
    track((async () => {
      await fillRequestPostData(params.requestId);
      try {
        const body = await bridge.send('Network.getResponseBody', { requestId: params.requestId });
        entry.responseBody = body?.body || '';
        entry.base64Encoded = !!body?.base64Encoded;
      } catch (error) {
        entry.responseBodyError = String(error);
      }
    })());
  };

  await bridge.send('Network.enable');
  bridge.on('Network.requestWillBeSent', onRequest);
  bridge.on('Network.responseReceived', onResponse);
  bridge.on('Network.loadingFinished', onFinished);

  return {
    async stop() {
      bridge.off('Network.requestWillBeSent', onRequest);
      bridge.off('Network.responseReceived', onResponse);
      bridge.off('Network.loadingFinished', onFinished);
      if (pending.size) {
        await Promise.allSettled([...pending]);
      }
      return order.map((id) => requests.get(id)).filter(Boolean);
    },
  };
}

async function nativeClickPoint(bridge, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Invalid click point');
  }

  await bridge.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await bridge.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await bridge.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

async function configureSearchViewport(bridge) {
  await bridge.send('Emulation.setDeviceMetricsOverride', SEARCH_VIEWPORT).catch(() => {});
}

async function dispatchKey(bridge, key, code, keyCode) {
  if (!bridge) return;

  const params = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };

  await bridge.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...params,
  });
  await bridge.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...params,
  });
}

async function dismissDatePickerIfPresent(bridge, page) {
  if (!bridge) return false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await inspectCombinedPageState(page).catch(() => null);
    if (!state?.dateDialogOpen) return attempt > 0;

    await confirmDateSelection(bridge, page).catch(() => {});
    await sleep(500);

    const afterConfirm = await inspectCombinedPageState(page).catch(() => null);
    if (!afterConfirm?.dateDialogOpen) return true;

    await pageEval(
      page,
      `(() => {
        document.body?.focus?.();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      })()`
    ).catch(() => {});
    await dispatchKey(bridge, 'Escape', 'Escape', 27).catch(() => {});
    await sleep(800);

    const afterEscape = await inspectCombinedPageState(page).catch(() => null);
    if (!afterEscape?.dateDialogOpen) return true;

    await clickVisibleText(page, 'Done').catch(() => {});
    await sleep(800);

    const afterDone = await inspectCombinedPageState(page).catch(() => null);
    if (!afterDone?.dateDialogOpen) return true;

    const dismissPoint = await findDateDialogDismissPoint(page).catch(() => null);
    if (dismissPoint) {
      await nativeClickPoint(bridge, dismissPoint);
      await sleep(800);
      const afterNativeDismiss = await inspectCombinedPageState(page).catch(() => null);
      if (!afterNativeDismiss?.dateDialogOpen) return true;
    }
  }

  return false;
}

async function countVisibleInputs(page, labels) {
  return pageEval(
    page,
    `(() => {
      const labels = ${JSON.stringify(labels)};
      const matchesLabel = (candidate) => {
        const normalized = String(candidate || '').trim();
        return labels.some((label) => {
          const expected = String(label || '').trim();
          return normalized === expected || normalized.startsWith(expected);
        });
      };
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const dedupeByPosition = (elements) => {
        const items = elements
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
        const unique = [];
        for (const item of items) {
          const previous = unique[unique.length - 1];
          if (
            previous
            && Math.abs(previous.rect.top - item.rect.top) < 4
            && Math.abs(previous.rect.left - item.rect.left) < 4
            && Math.abs(previous.rect.width - item.rect.width) < 4
            && Math.abs(previous.rect.height - item.rect.height) < 4
          ) {
            continue;
          }
          unique.push(item);
        }
        return unique.map((item) => item.el);
      };
      return dedupeByPosition(Array.from(document.querySelectorAll('input')).filter((el) => {
        const aria = (el.getAttribute('aria-label') || '').trim();
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        return visible(el) && (matchesLabel(aria) || matchesLabel(placeholder));
      })).length;
    })()`
  );
}

async function getVisibleInputValueByLabels(page, labels, index = 0) {
  return pageEval(
    page,
    `(() => {
      const labels = ${JSON.stringify(labels)};
      const index = ${JSON.stringify(index)};
      const matchesLabel = (candidate) => {
        const normalized = String(candidate || '').trim();
        return labels.some((label) => {
          const expected = String(label || '').trim();
          return normalized === expected || normalized.startsWith(expected);
        });
      };
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const dedupeByPosition = (elements) => {
        const items = elements
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
        const unique = [];
        for (const item of items) {
          const previous = unique[unique.length - 1];
          if (
            previous
            && Math.abs(previous.rect.top - item.rect.top) < 4
            && Math.abs(previous.rect.left - item.rect.left) < 4
            && Math.abs(previous.rect.width - item.rect.width) < 4
            && Math.abs(previous.rect.height - item.rect.height) < 4
          ) {
            continue;
          }
          unique.push(item);
        }
        return unique.map((item) => item.el);
      };
      const matches = dedupeByPosition(Array.from(document.querySelectorAll('input')).filter((el) => {
        const aria = (el.getAttribute('aria-label') || '').trim();
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        return visible(el) && (matchesLabel(aria) || matchesLabel(placeholder));
      }));
      return matches[index]?.value || '';
    })()`
  );
}

async function setVisibleInputByLabels(page, labels, value, index = 0, options = {}) {
  const deadline = Date.now() + INPUT_WAIT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await pageEval(
        page,
        `(() => {
          const labels = ${JSON.stringify(labels)};
          const value = ${JSON.stringify(value)};
          const index = ${JSON.stringify(index)};
          const focusInput = ${JSON.stringify(options.focusInput !== false)};
          const matchesLabel = (candidate) => {
            const normalized = String(candidate || '').trim();
            return labels.some((label) => {
              const expected = String(label || '').trim();
              return normalized === expected || normalized.startsWith(expected);
            });
          };
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const dedupeByPosition = (elements) => {
            const items = elements
              .map((el) => ({ el, rect: el.getBoundingClientRect() }))
              .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
            const unique = [];
            for (const item of items) {
              const previous = unique[unique.length - 1];
              if (
                previous
                && Math.abs(previous.rect.top - item.rect.top) < 4
                && Math.abs(previous.rect.left - item.rect.left) < 4
                && Math.abs(previous.rect.width - item.rect.width) < 4
                && Math.abs(previous.rect.height - item.rect.height) < 4
              ) {
                continue;
              }
              unique.push(item);
            }
            return unique.map((item) => item.el);
          };
          const matches = dedupeByPosition(Array.from(document.querySelectorAll('input')).filter((el) => {
            const aria = (el.getAttribute('aria-label') || '').trim();
            const placeholder = (el.getAttribute('placeholder') || '').trim();
            return visible(el) && (matchesLabel(aria) || matchesLabel(placeholder));
          }));
          const input = matches[index];
          if (!input) throw new Error('Visible input not found: ' + labels.join(' / ') + ' #' + index);
          input.scrollIntoView({ block: 'center' });
          if (focusInput) input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw lastError || new Error('Visible input not found');
}

async function confirmVisibleInput(page, labels, index, choiceText) {
  const deadline = Date.now() + INPUT_WAIT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await pageEval(
        page,
        `(() => {
          const labels = ${JSON.stringify(labels)};
          const index = ${JSON.stringify(index)};
          const exact = ${JSON.stringify(trimValue(choiceText).toLowerCase())};
          const matchesLabel = (candidate) => {
            const normalized = String(candidate || '').trim();
            return labels.some((label) => {
              const expected = String(label || '').trim();
              return normalized === expected || normalized.startsWith(expected);
            });
          };
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const dedupeByPosition = (elements) => {
            const items = elements
              .map((el) => ({ el, rect: el.getBoundingClientRect() }))
              .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
            const unique = [];
            for (const item of items) {
              const previous = unique[unique.length - 1];
              if (
                previous
                && Math.abs(previous.rect.top - item.rect.top) < 4
                && Math.abs(previous.rect.left - item.rect.left) < 4
                && Math.abs(previous.rect.width - item.rect.width) < 4
                && Math.abs(previous.rect.height - item.rect.height) < 4
              ) {
                continue;
              }
              unique.push(item);
            }
            return unique.map((item) => item.el);
          };
          const inputs = dedupeByPosition(Array.from(document.querySelectorAll('input')).filter((el) => {
            const aria = (el.getAttribute('aria-label') || '').trim();
            const placeholder = (el.getAttribute('placeholder') || '').trim();
            return visible(el) && (matchesLabel(aria) || matchesLabel(placeholder));
          }));
          const input = (document.activeElement instanceof HTMLInputElement && visible(document.activeElement))
            ? document.activeElement
            : inputs[index];
          if (!input) throw new Error('Visible input not found for confirmation');
          if (!exact) throw new Error('Choice text is required');

          const optionSelectors = ['[role="option"]', 'li[role="option"]', 'li'];
          let target = null;
          for (const selector of optionSelectors) {
            const candidates = Array.from(document.querySelectorAll(selector))
              .filter((el) => visible(el))
              .map((el) => ({
                el,
                aria: (el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase(),
                text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase(),
              }));
            target = candidates.find((item) => item.aria === exact)?.el
              || candidates.find((item) => item.aria.includes(exact))?.el
              || candidates.find((item) => item.text === exact)?.el
              || candidates.find((item) => item.text.startsWith(exact))?.el
              || candidates.find((item) => item.text.includes(exact))?.el
              || null;
            if (target) break;
          }

          if (target) {
            target.scrollIntoView({ block: 'center' });
            target.click();
            return;
          }

          const eventInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
          input.dispatchEvent(new KeyboardEvent('keydown', eventInit));
          input.dispatchEvent(new KeyboardEvent('keypress', eventInit));
          input.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        })()`
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw lastError || new Error('Visible input not found for confirmation');
}

async function clickVisibleText(page, text) {
  await pageEval(
    page,
    `(() => {
      const text = ${JSON.stringify(text)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const target = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], [role="option"], [role="menuitem"], li, div, span'))
        .find((el) => visible(el) && normalize(el.innerText || el.textContent) === text);
      if (!target) throw new Error('Visible control not found: ' + text);
      target.scrollIntoView({ block: 'center' });
      const fire = (type) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      fire('pointerdown');
      fire('mousedown');
      fire('pointerup');
      fire('mouseup');
      fire('click');
    })()`
  );
}

async function clickVisibleAria(page, ariaLabels) {
  await pageEval(
    page,
    `(() => {
      const labels = ${JSON.stringify(ariaLabels)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const target = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], div, span'))
        .find((el) => visible(el) && labels.includes((el.getAttribute('aria-label') || '').trim()));
      if (!target) throw new Error('Visible aria control not found: ' + labels.join(', '));
      target.scrollIntoView({ block: 'center' });
      const fire = (type) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      fire('pointerdown');
      fire('mousedown');
      fire('pointerup');
      fire('mouseup');
      fire('click');
    })()`
  );
}

async function findDateInputPoint(page, labels, index) {
  const deadline = Date.now() + INPUT_WAIT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await pageEval(
        page,
        `(() => {
          const labels = ${JSON.stringify(labels)};
          const index = ${JSON.stringify(index)};
          const matchesLabel = (candidate) => {
            const normalized = String(candidate || '').trim();
            return labels.some((label) => {
              const expected = String(label || '').trim();
              return normalized === expected || normalized.startsWith(expected);
            });
          };
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const dedupeByPosition = (elements) => {
            const items = elements
              .map((el) => ({ el, rect: el.getBoundingClientRect() }))
              .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
            const unique = [];
            for (const item of items) {
              const previous = unique[unique.length - 1];
              if (
                previous
                && Math.abs(previous.rect.top - item.rect.top) < 4
                && Math.abs(previous.rect.left - item.rect.left) < 4
                && Math.abs(previous.rect.width - item.rect.width) < 4
                && Math.abs(previous.rect.height - item.rect.height) < 4
              ) {
                continue;
              }
              unique.push(item);
            }
            return unique.map((item) => item.el);
          };
          const controls = dedupeByPosition(Array.from(document.querySelectorAll('input, [role="combobox"], button, [role="button"]')).filter((el) => {
            const aria = (el.getAttribute('aria-label') || '').trim();
            const placeholder = (el.getAttribute('placeholder') || '').trim();
            return visible(el) && (matchesLabel(aria) || matchesLabel(placeholder));
          }));
          const input = controls[index];
          if (!input) throw new Error('Date input not found: ' + labels.join(' / ') + ' #' + index);
          input.scrollIntoView({ block: 'center' });
          const rect = input.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`
      );
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw lastError || new Error('Date input not found');
}

async function findLocationFieldPoint(page, labels, index) {
  const deadline = Date.now() + INPUT_WAIT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await pageEval(
        page,
        `(() => {
          const labels = ${JSON.stringify(labels)};
          const index = ${JSON.stringify(index)};
          const isDestination = labels.some((label) => String(label || '').toLowerCase().includes('where to'));
          const matchesLabel = (candidate) => {
            const normalized = String(candidate || '').trim();
            return labels.some((label) => {
              const expected = String(label || '').trim();
              return normalized === expected || normalized.startsWith(expected);
            });
          };
          const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const dedupeByPosition = (elements) => {
            const items = elements
              .map((el) => ({ el, rect: el.getBoundingClientRect() }))
              .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
            const unique = [];
            for (const item of items) {
              const previous = unique[unique.length - 1];
              if (
                previous
                && Math.abs(previous.rect.top - item.rect.top) < 4
                && Math.abs(previous.rect.left - item.rect.left) < 4
                && Math.abs(previous.rect.width - item.rect.width) < 4
                && Math.abs(previous.rect.height - item.rect.height) < 4
              ) {
                continue;
              }
              unique.push(item);
            }
            return unique;
          };

          const swapButtons = dedupeByPosition(Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter((el) => visible(el) && normalize(el.getAttribute('aria-label') || '') === 'Swap origin and destination.'));
          const swap = swapButtons[index];
          if (!swap) throw new Error('Location row not found: ' + labels.join(' / ') + ' #' + index);

          const swapRect = swap.rect;
          const swapCenterY = swapRect.top + swapRect.height / 2;
          const searchAreaTop = Math.max(0, swapRect.top - 80);
          const searchAreaBottom = swapRect.bottom + 80;

          const candidates = dedupeByPosition(Array.from(document.querySelectorAll('input, button, [role="button"], [role="combobox"], div, span'))
            .filter((el) => {
              if (!visible(el)) return false;
              const rect = el.getBoundingClientRect();
              const centerY = rect.top + rect.height / 2;
              if (centerY < searchAreaTop || centerY > searchAreaBottom) return false;
              if (rect.width < 20 || rect.height < 20) return false;
              const text = normalize(el.innerText || el.textContent || '');
              const aria = normalize(el.getAttribute('aria-label') || '');
              const placeholder = normalize(el.getAttribute('placeholder') || '');

              if (isDestination) {
                return (
                  rect.left >= swapRect.right - 8
                  && (matchesLabel(text) || matchesLabel(aria) || matchesLabel(placeholder) || /select multiple airports/i.test(text))
                );
              }

              if (rect.right > swapRect.left + 8) return false;
              if (!text && !aria && !placeholder) return false;
              if (/round trip|one way|multi-city|economy|passenger|search|explore/i.test(text)) return false;
              return Math.abs(centerY - swapCenterY) < 60;
            }))
            .map((item) => {
              const el = item.el;
              const rect = item.rect;
              const text = normalize(el.innerText || el.textContent || '');
              const aria = normalize(el.getAttribute('aria-label') || '');
              const placeholder = normalize(el.getAttribute('placeholder') || '');
              const distance = isDestination
                ? Math.abs(rect.left - swapRect.right)
                : Math.abs(swapRect.left - rect.right);
              const area = rect.width * rect.height;
              return { el, rect, text, aria, placeholder, distance, area };
            })
            .sort((left, right) => {
              if (left.distance !== right.distance) return left.distance - right.distance;
              return right.area - left.area;
            });

          const target = candidates[0];
          if (!target) throw new Error('Location field not found: ' + labels.join(' / ') + ' #' + index);
          target.el.scrollIntoView({ block: 'center' });
          return {
            x: target.rect.left + target.rect.width / 2,
            y: target.rect.top + target.rect.height / 2,
          };
        })()`
      );
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw lastError || new Error('Location field not found');
}

async function openDateInput(bridge, page, labels, index) {
  const point = await findDateInputPoint(page, labels, index);
  await sleep(100);
  await nativeClickPoint(bridge, point);
  await sleep(UI_SETTLE_MS);
}

async function advanceDatePicker(page) {
  return pageEval(
    page,
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const clickLike = (el) => {
        const fire = (type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        fire('pointerdown');
        fire('mousedown');
        fire('pointerup');
        fire('mouseup');
        fire('click');
      };

      const nextControl = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'))
        .map((el) => el.closest('button, [role="button"]') || el)
        .find((el) => {
          if (!visible(el)) return false;
          const haystack = normalize(el.innerText || el.textContent) + ' ' + normalize(el.getAttribute('aria-label') || '');
          return haystack.includes('next month');
        });
      if (nextControl) {
        nextControl.scrollIntoView({ block: 'center' });
        clickLike(nextControl);
        return true;
      }

      const scrollingElement = document.scrollingElement || document.documentElement;
      const dateNode = Array.from(document.querySelectorAll('[role="gridcell"][data-iso], [role="gridcell"], [aria-label]'))
        .find((el) => {
          if (!visible(el)) return false;
          return !!(el.getAttribute('data-iso') || '').trim()
            || /,\\s*\\d{4}/.test((el.getAttribute('aria-label') || '').trim());
        });

      let container = dateNode?.parentElement || null;
      while (container) {
        if (container.scrollHeight > container.clientHeight + 20) break;
        container = container.parentElement;
      }

      const amount = Math.max(320, Math.round(window.innerHeight * 0.75));
      if (container && container !== document.body && container !== document.documentElement) {
        const before = container.scrollTop;
        container.scrollTop += amount;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        return container.scrollTop > before;
      }

      const before = scrollingElement.scrollTop;
      window.scrollBy(0, amount);
      return scrollingElement.scrollTop > before;
    })()`
  );
}

async function getVisibleCalendarDateBounds(page) {
  return pageEval(
    page,
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const parseDateLabel = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const cleaned = raw.replace(/, selected.*$/i, '');
        const parsed = new Date(cleaned);
        return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
      };
      const dates = Array.from(document.querySelectorAll('[role="gridcell"][data-iso], [role="gridcell"], [aria-label]'))
        .filter((el) => visible(el))
        .map((el) => (el.getAttribute('data-iso') || '').trim() || parseDateLabel(el.getAttribute('aria-label')))
        .filter(Boolean)
        .sort();
      return {
        minDate: dates[0] || '',
        maxDate: dates[dates.length - 1] || '',
      };
    })()`
  );
}

async function findDateCellPoint(page, isoDate) {
  return pageEval(
    page,
    `(() => {
      const targetIso = ${JSON.stringify(isoDate)};
      const targetAria = ${JSON.stringify(formatAriaDate(isoDate))};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const target = Array.from(document.querySelectorAll('[role="gridcell"][data-iso]'))
        .find((el) => visible(el) && (el.getAttribute('data-iso') || '').trim() === targetIso)
        || Array.from(document.querySelectorAll('[aria-label]'))
          .map((el) => el.closest('[role="gridcell"], [role="button"], button') || el)
          .find((el) => {
            if (!visible(el)) return false;
            const aria = (el.getAttribute('aria-label') || '').trim();
            return aria === targetAria || aria.startsWith(targetAria + ',');
          })
        || Array.from(document.querySelectorAll('[aria-label]'))
          .map((el) => el.closest('[role="gridcell"], [role="button"], button') || el)
          .find((el) => {
            if (!visible(el)) return false;
            const inner = Array.from(el.querySelectorAll?.('[aria-label]') || []).find((child) => {
              const aria = (child.getAttribute('aria-label') || '').trim();
              return aria === targetAria || aria.startsWith(targetAria + ',');
            });
            return !!inner;
          });
      if (!target) throw new Error('Date cell not found: ' + targetAria);
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  );
}

async function clickDateCell(bridge, page, isoDate) {
  let point = await findDateCellPoint(page, isoDate).catch(() => null);
  if (!point) {
    for (let step = 0; step < MAX_DATE_ADVANCE_STEPS; step += 1) {
      const advanced = await advanceDatePicker(page);
      if (!advanced) break;
      await sleep(UI_SETTLE_MS);
      point = await findDateCellPoint(page, isoDate).catch(() => null);
      if (point) break;
    }
  }
  if (!point) {
    const bounds = await getVisibleCalendarDateBounds(page).catch(() => null);
    if (bounds?.maxDate && isoDate > bounds.maxDate) {
      throw new ArgumentError(`Google Flights currently exposes dates through ${bounds.maxDate}; ${isoDate} is not selectable yet`);
    }
    if (bounds?.minDate && isoDate < bounds.minDate) {
      throw new ArgumentError(`Google Flights currently exposes dates from ${bounds.minDate}; ${isoDate} is earlier than the visible search window`);
    }
    point = await findDateCellPoint(page, isoDate);
  }
  await sleep(100);
  await nativeClickPoint(bridge, point);
  await sleep(UI_SETTLE_MS);
}

async function findDateConfirmationPoint(page) {
  return pageEval(
    page,
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const matchesDone = (el) => {
        const text = normalize(el.innerText || el.textContent);
        const aria = normalize(el.getAttribute('aria-label') || '');
        return text === 'Done' || aria === 'Done' || aria.startsWith('Done.');
      };
      const target = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find((el) => {
          if (!visible(el)) return false;
          return matchesDone(el);
        })
        || Array.from(document.querySelectorAll('div, span'))
          .find((el) => visible(el) && matchesDone(el));
      if (!target) throw new Error('Date confirmation control not found');
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  );
}

async function findDateDialogDismissPoint(page) {
  return pageEval(
    page,
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const candidates = Array.from(document.querySelectorAll('div, section, dialog, [role="dialog"]'))
        .filter((el) => visible(el) && /enter a date or use the arrow keys/i.test(normalize(el.innerText || el.textContent || '')))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .sort((left, right) => (right.rect.width * right.rect.height) - (left.rect.width * left.rect.height));
      const target = candidates[0];
      if (!target) throw new Error('Date dialog container not found');
      return {
        x: target.rect.right - Math.min(56, Math.max(24, target.rect.width * 0.08)),
        y: target.rect.bottom - Math.min(24, Math.max(16, target.rect.height * 0.04)),
      };
    })()`
  );
}

async function confirmDateSelection(bridge, page) {
  const point = await findDateConfirmationPoint(page).catch(() => null);
  if (point) {
    await sleep(100);
    await nativeClickPoint(bridge, point);
  }
  await sleep(UI_SETTLE_MS);
}

async function selectTripType(page, label) {
  await pageEval(
    page,
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const combo = Array.from(document.querySelectorAll('[role="combobox"]'))
        .find((el) => visible(el) && /round trip|one way|multi-city/i.test((el.innerText || el.textContent || '').trim()));
      if (!combo) throw new Error('Trip type combobox not found');
      combo.scrollIntoView({ block: 'center' });
      combo.click();
    })()`
  );

  await sleep(UI_SETTLE_MS);
  await clickVisibleText(page, label);
  await sleep(UI_SETTLE_MS);
}

async function fillLocationInput(bridge, page, labels, value, index) {
  let point = await findDateInputPoint(page, labels, index).catch(() => null);
  if (!point) {
    point = await findLocationFieldPoint(page, labels, index);
  }
  await sleep(100);
  await nativeClickPoint(bridge, point);
  await sleep(200);
  await pageEval(
    page,
    `(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement) {
        active.focus();
        active.select();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter.call(active, '');
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`
  );
  await bridge.send('Input.insertText', { text: value });
  await sleep(AUTOCOMPLETE_WAIT_MS);
  await confirmVisibleInput(page, labels, index, value);
  await sleep(UI_SETTLE_MS);

  const committedValue = trimValue(await getVisibleInputValueByLabels(page, labels, index));
  if (committedValue) {
    return;
  }

  await setVisibleInputByLabels(page, labels, value, index);
  await sleep(AUTOCOMPLETE_WAIT_MS);
  await confirmVisibleInput(page, labels, index, value);
  await sleep(UI_SETTLE_MS);
}

async function fillDateInput(bridge, page, labels, value, index) {
  const formattedValue = formatInputDate(value);
  const point = await findDateInputPoint(page, labels, index);
  await sleep(100);
  await nativeClickPoint(bridge, point);
  await sleep(200);
  await pageEval(
    page,
    `(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement) {
        active.focus();
        active.select();
      }
    })()`
  );
  await bridge.send('Input.insertText', { text: formattedValue });
  await dispatchKey(bridge, 'Enter', 'Enter', 13);
  await dismissDatePickerIfPresent(bridge, page).catch(() => {});
  await sleep(UI_SETTLE_MS);

  const committedValue = trimValue(await getVisibleInputValueByLabels(page, labels, index));
  if (committedValue.toLowerCase() === formattedValue.toLowerCase()) {
    return;
  }

  await pickSingleDate(bridge, page, index, value);
}

async function submitSearch(page) {
  await clickVisibleAria(page, ['Search', 'Explore flights']).catch(async () => {
    await clickVisibleText(page, 'Search').catch(async () => {
      await clickVisibleText(page, 'Explore');
    });
  });
  await sleep(UI_SETTLE_MS);
}

async function pickSingleDate(bridge, page, index, isoDate) {
  await openDateInput(bridge, page, DEPARTURE_LABELS, index);
  await clickDateCell(bridge, page, isoDate);
  await confirmDateSelection(bridge, page);
  await dismissDatePickerIfPresent(bridge, page).catch(() => {});
}

async function pickRoundTripDates(bridge, page, departDate, returnDate) {
  await openDateInput(bridge, page, DEPARTURE_LABELS, 0);
  await clickDateCell(bridge, page, departDate);
  await clickDateCell(bridge, page, returnDate);
  await confirmDateSelection(bridge, page);
  await dismissDatePickerIfPresent(bridge, page).catch(() => {});
}

async function ensureSegmentRows(page, targetCount) {
  while ((await countVisibleInputs(page, ORIGIN_LABELS)) < targetCount) {
    await clickVisibleText(page, 'Add flight');
    await sleep(UI_SETTLE_MS);
  }
}

async function getCurrentUrl(page) {
  return pageEval(page, 'window.location.href');
}

async function assertGoogleFlightsAccessible(page) {
  const state = await pageEval(
    page,
    `(() => {
      const url = window.location.href;
      const title = document.title || '';
      const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      const blocked = url.includes('/sorry/')
        || /unusual traffic/i.test(bodyText)
        || /recaptcha/i.test(bodyText)
        || /our systems have detected unusual traffic/i.test(bodyText);
      return { url, title, blocked, bodyText: bodyText.slice(0, 500) };
    })()`
  ).catch(() => null);

  if (state?.blocked) {
    throw new CliError(
      'FETCH_ERROR',
      'Google Flights is showing a bot-check or unusual-traffic page',
      'Retry later, reduce repeated searches, or use OPENCLI_CDP_ENDPOINT to connect to your own Chrome session'
    );
  }
}

function isSearchResultUrl(rawUrl) {
  try {
    const parsed = new URL(trimValue(rawUrl));
    return parsed.pathname.startsWith('/travel/flights/search') && parsed.searchParams.has('tfs');
  } catch {
    return false;
  }
}

async function resolveSearchUrl(page, previousUrl) {
  const startedAt = Date.now();
  const deadline = Date.now() + URL_WAIT_MS;
  let lastUrl = trimValue(await getCurrentUrl(page)) || trimValue(previousUrl);
  let lastChangedAt = startedAt;
  const previousSearchUrl = isSearchResultUrl(previousUrl) ? trimValue(previousUrl) : '';
  let latestSearchUrl = isSearchResultUrl(lastUrl) && lastUrl !== previousSearchUrl ? lastUrl : '';

  while (Date.now() < deadline) {
    const currentUrl = trimValue(await getCurrentUrl(page));
    if (currentUrl) {
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        lastChangedAt = Date.now();
      }

      if (isSearchResultUrl(currentUrl) && currentUrl !== previousSearchUrl) {
        latestSearchUrl = currentUrl;
      }

      if (
        latestSearchUrl &&
        Date.now() - startedAt >= MIN_POST_EDIT_WAIT_MS &&
        Date.now() - lastChangedAt >= URL_STABLE_MS
      ) {
        return latestSearchUrl;
      }
    }

    await sleep(500);
  }

  if (latestSearchUrl) {
    return latestSearchUrl;
  }

  throw new CliError(
    'TIMEOUT_ERROR',
    `Google Flights search URL was not generated in time${lastUrl ? ` (last URL: ${lastUrl})` : ''}`,
    'Try airport or city names that match Google Flights suggestions more closely'
  );
}

async function openSearchSession(itinerary, endpoint, options = {}) {
  const bridge = new CDPBridge();
  const page = await bridge.connect({ cdpEndpoint: endpoint, timeout: 15 });
  await configureSearchViewport(bridge);
  const networkCapture = await startNetworkCapture(bridge, 'GetShoppingResults');
  const keepOpen = options.keepOpen === true;
  let captureStopped = false;

  try {
    const outputSegments = expandOutputSegments(itinerary);
    const usingExternalCdp = Boolean(trimValue(process.env.OPENCLI_CDP_ENDPOINT));
    const segmentsUseAirportCodes = outputSegments.length > 0
      && outputSegments.every((segment) => isAirportCodeToken(segment.origin) && isAirportCodeToken(segment.destination));
    const useDirectSearchUrl = (
      itinerary.tripType === 'multi-city'
      && itinerary.segments.length > 2
      && options.preferDirectSearchUrl !== false
    ) || (
      usingExternalCdp
      && segmentsUseAirportCodes
      && options.preferDirectSearchUrl !== false
    );

    if (useDirectSearchUrl) {
      const searchUrl = buildSegmentedSearchUrl(outputSegments);
      await page.goto(searchUrl);
      await sleep(5000);
      await assertGoogleFlightsAccessible(page);
      if (options.requireShoppingResults === true) {
        await page.goto(searchUrl).catch(() => {});
        await sleep(3000);
        await assertGoogleFlightsAccessible(page);
      }
      const currentUrl = trimValue(await getCurrentUrl(page));
      const effectiveSearchUrl = isSearchResultUrl(currentUrl) ? currentUrl : searchUrl;

      const shoppingEntries = filterShoppingResultEntries(await networkCapture.stop());
      const shoppingResults = filterShoppingResultBodies(shoppingEntries);
      debugLog('openSearchSession:multiCityDirect', {
        searchUrl: effectiveSearchUrl,
        shoppingEntries: shoppingEntries.length,
        shoppingResults: shoppingResults.length,
      });
      captureStopped = true;

      return {
        bridge,
        page,
        searchUrl: effectiveSearchUrl,
        canonicalSearchUrl: searchUrl,
        shoppingEntries,
        shoppingResults,
        async close() {
          await bridge.close().catch(() => {});
        },
        keepOpen,
      };
    }

    await page.goto(SEED_SEARCH_URL);
    await page.wait(4);
    await assertGoogleFlightsAccessible(page);

    let initialUrl = trimValue(await getCurrentUrl(page));

    if (itinerary.tripType === 'one-way') {
      await selectTripType(page, 'One way');
      const [segment] = itinerary.segments;
      await fillLocationInput(bridge, page, ORIGIN_LABELS, segment.origin, 0);
      await fillLocationInput(bridge, page, DESTINATION_LABELS, segment.destination, 0);
      await pickSingleDate(bridge, page, 0, segment.date);
    } else if (itinerary.tripType === 'round-trip') {
      const [segment] = itinerary.segments;
      await selectTripType(page, 'Round trip').catch(() => {});
      await fillLocationInput(bridge, page, ORIGIN_LABELS, segment.origin, 0);
      await fillLocationInput(bridge, page, DESTINATION_LABELS, segment.destination, 0);
      await pickRoundTripDates(bridge, page, segment.date, itinerary.returnDate);
    } else {
      await selectTripType(page, 'Multi-city');
      await ensureSegmentRows(page, itinerary.segments.length);
      for (const [index, segment] of itinerary.segments.entries()) {
        await fillLocationInput(bridge, page, ORIGIN_LABELS, segment.origin, index);
      }
      for (const [index, segment] of itinerary.segments.entries()) {
        await fillLocationInput(bridge, page, DESTINATION_LABELS, segment.destination, index);
      }
      for (let index = itinerary.segments.length - 1; index >= 0; index -= 1) {
        const segment = itinerary.segments[index];
        await fillDateInput(bridge, page, DEPARTURE_LABELS, segment.date, index);
      }
    }

    await dismissDatePickerIfPresent(bridge, page).catch(() => {});
    await submitSearch(page).catch(() => {});
    await sleep(1000);
    const searchUrl = await resolveSearchUrl(page, initialUrl);
    await dismissDatePickerIfPresent(bridge, page).catch(() => {});
    await sleep(1500);

    const shoppingEntries = filterShoppingResultEntries(await networkCapture.stop());
    const shoppingResults = filterShoppingResultBodies(shoppingEntries);
    captureStopped = true;

    return {
      bridge,
      page,
      searchUrl,
      shoppingEntries,
      shoppingResults,
      async close() {
        await bridge.close().catch(() => {});
      },
      keepOpen,
    };
  } finally {
    if (!captureStopped) {
      await networkCapture.stop();
      captureStopped = true;
    }
    if (!keepOpen) {
      await bridge.close().catch(() => {});
    }
  }
}

async function buildSearchSession(itinerary, endpoint) {
  const session = await openSearchSession(itinerary, endpoint);
  return {
    searchUrl: session.searchUrl,
    shoppingEntries: session.shoppingEntries || [],
    shoppingResults: session.shoppingResults,
  };
}

async function collectFlightsForItinerary(itinerary, endpoint, outputTripType, limit) {
  const { searchUrl, shoppingResults } = await buildSearchSession(itinerary, endpoint);
  const html = await fetchHtml(searchUrl);
  const title = extractTitle(html);

  const shoppingFlights = decorateFlights(extractShoppingFlights(shoppingResults, limit), searchUrl, outputTripType);
  const htmlFlights = decorateFlights(extractFlights(html, limit), searchUrl, outputTripType);
  const flights = shoppingFlights.length ? shoppingFlights : htmlFlights;

  return { searchUrl, title, flights };
}

async function collectCombinedMultiCityFlights(itinerary, endpoint, limit) {
  const { searchUrl, shoppingResults } = await buildSearchSession(itinerary, endpoint);
  const html = await fetchHtml(searchUrl);
  const title = extractTitle(html);
  const activeSegmentIndex = resolveMultiCitySegmentIndexByTitle(itinerary, title);
  const activeSegment = itinerary.segments[activeSegmentIndex] || itinerary.segments[0];

  const shoppingFlights = decorateFlights(extractShoppingFlights(shoppingResults, limit), searchUrl, itinerary.tripType);
  const htmlFlights = decorateFlights(extractFlights(html, limit), searchUrl, itinerary.tripType);
  const flights = shoppingFlights.length ? shoppingFlights : htmlFlights;

  return {
    searchUrl,
    title,
    activeSegmentIndex,
    flights: annotateFlightsForSegment(flights, activeSegment, activeSegmentIndex),
  };
}

async function collectCombinedBundlesViaApi(page, itinerary, searchUrl, shoppingEntries, limit) {
  const outputSegments = expandOutputSegments(itinerary);
  const branchWidth = Math.min(2, resolveCombinedBranchWidth(limit, outputSegments.length));
  const maxBundles = Math.max(limit, 1);
  const parsedEntry = [...shoppingEntries]
    .reverse()
    .map((entry) => ({
      entry,
      parsed: parseShoppingRequestEntry(entry),
    }))
    .find((item) => item.parsed);
  const baseEntry = parsedEntry?.entry || [...shoppingEntries].reverse().find((entry) => trimValue(entry.postData));
  const parsedRequest = parsedEntry?.parsed || null;
  debugLog('collectCombinedBundlesViaApi:base', {
    shoppingEntries: shoppingEntries.length,
    hasBaseEntry: Boolean(baseEntry),
    hasParsedRequest: Boolean(parsedRequest),
    responseBodyLength: String(baseEntry?.responseBody || '').length,
  });

  if (!parsedRequest) {
    throw new CliError(
      'FETCH_ERROR',
      'Google Flights combined API fallback could not recover the shopping request payload',
      'Retry the search so a fresh shopping request can be captured'
    );
  }

  const initialBody = baseEntry?.responseBody || await replayShoppingResultsRequest(page, parsedRequest, parsedRequest.inner, parsedRequest.rawPostData);
  debugLog('collectCombinedBundlesViaApi:initialBody', {
    length: String(initialBody || '').length,
  });
  const title = `${outputSegments[0]?.origin || ''} itinerary | Google Flights`;
  const bundles = [];

  await exploreCombinedBundlesViaApi(
    page,
    parsedRequest,
    cloneJson(parsedRequest.inner),
    itinerary,
    searchUrl,
    title,
    outputSegments,
    0,
    branchWidth,
    [],
    bundles,
    maxBundles,
    initialBody
  );

  const dedupedBundles = dedupeCombinedBundles(bundles)
    .sort((left, right) => (left.price_value || Number.POSITIVE_INFINITY) - (right.price_value || Number.POSITIVE_INFINITY))
    .slice(0, limit);

  debugLog('collectCombinedBundlesViaApi:done', {
    bundles: bundles.length,
    dedupedBundles: dedupedBundles.length,
  });

  return {
    title,
    searchUrl,
    branchWidth,
    bundles: dedupedBundles,
    rows: dedupedBundles.map((bundle, index) => buildCombinedBundleRow(bundle, index + 1)),
  };
}

async function collectCombinedBundlesForItinerary(itinerary, endpoint, limit) {
  const outputSegments = expandOutputSegments(itinerary);
  const branchWidth = resolveCombinedBranchWidth(limit, outputSegments.length);
  const maxBundles = Math.max(limit * 3, branchWidth);
  const apiOnly = itinerary.tripType === 'multi-city' && itinerary.segments.length > 2;
  const apiAttempts = outputSegments.length > 1 ? (apiOnly ? 3 : 1) : 0;
  let lastApiError = null;

  for (let attempt = 1; attempt <= apiAttempts; attempt += 1) {
    const session = await openSearchSession(itinerary, endpoint, {
      keepOpen: true,
      requireShoppingResults: true,
    });

    try {
      const apiResult = await collectCombinedBundlesViaApi(
        session.page,
        itinerary,
        session.searchUrl,
        session.shoppingEntries || [],
        limit
      );
      debugLog('collectCombinedBundlesForItinerary:apiResult', {
        attempt,
        rows: apiResult.rows.length,
        bundles: apiResult.bundles.length,
      });
      if (apiResult.rows.length) {
        return apiResult;
      }
      lastApiError = new CliError(
        'FETCH_ERROR',
        'Google Flights combined API did not produce any bundled results',
        'Retry the search; Google may be throttling the current shopping session'
      );
    } catch (error) {
      lastApiError = error;
      debugLog('collectCombinedBundlesForItinerary:apiError', {
        attempt,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
    } finally {
      await session.close().catch(() => {});
    }

    if (attempt < apiAttempts) {
      await sleep(1000 * attempt);
    }
  }

  if (apiOnly) {
    if (lastApiError instanceof CliError) throw lastApiError;
    throw new CliError(
      'FETCH_ERROR',
      'Google Flights combined API did not produce any bundled results',
      'Retry the search; Google may be throttling the current shopping session'
    );
  }

  const session = await openSearchSession(itinerary, endpoint, {
    keepOpen: true,
    requireShoppingResults: outputSegments.length > 1,
  });

  try {
    const currentUrl = trimValue(await getCurrentUrl(session.page).catch(() => ''));
    if (!isSearchResultUrl(currentUrl)) {
      await session.page.goto(session.searchUrl);
      await sleep(1500);
    } else if (currentUrl !== session.searchUrl && trimValue(session.searchUrl)) {
      await session.page.goto(session.searchUrl).catch(() => {});
      await sleep(1500);
    }

    await dismissDatePickerIfPresent(session.bridge, session.page).catch(() => {});
    await waitForCombinedPageState(session.page, session.bridge);
    const bundles = [];
    await exploreCombinedBundles(
      session.page,
      session.bridge,
      itinerary,
      session.searchUrl,
      outputSegments,
      0,
      branchWidth,
      [],
      bundles,
      maxBundles
    );

    const dedupedBundles = dedupeCombinedBundles(bundles)
      .sort((left, right) => (left.price_value || Number.POSITIVE_INFINITY) - (right.price_value || Number.POSITIVE_INFINITY))
      .slice(0, limit);

    const rows = dedupedBundles.map((bundle, index) => buildCombinedBundleRow(bundle, index + 1));
    const title = dedupedBundles[0]?.title || `${outputSegments[0]?.origin || ''} itinerary | Google Flights`;

    return {
      title,
      searchUrl: session.searchUrl,
      branchWidth,
      bundles: dedupedBundles,
      rows,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

cli({
  site: 'google-flights',
  name: 'search',
  description: 'Search Google Flights by origin, destination, dates, or multi-city itinerary',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'from', help: 'Origin for one-way or round-trip searches' },
    { name: 'to', help: 'Destination for one-way or round-trip searches' },
    { name: 'depart', help: 'Departure date in YYYY-MM-DD format' },
    { name: 'return', help: 'Return date in YYYY-MM-DD format for round-trip searches' },
    {
      name: 'segments',
      help: 'Multi-city itinerary, for example "Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-20"',
    },
    { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Number of rows to return (max ${MAX_LIMIT})` },
    { name: 'combined', type: 'bool', default: false, help: 'For multi-city, use Google Flights native combined pricing and walk the live selection flow to final bundled totals' },
    { name: 'api', type: 'bool', default: false, help: 'Return structured JSON payload for programmatic use' },
  ],
  columns: ['segment_index', 'segment_route', 'rank', 'price', 'airline', 'flight_number', 'stops', 'depart', 'arrive', 'duration', 'from_airport', 'to_airport'],
  func: async (_page, kwargs) => {
    const itinerary = resolveItinerary(kwargs);
    const limit = clampLimit(kwargs.limit);
    const combined = kwargs.combined === true;
    const browser = await ensureCdpEndpoint();

    try {
      let title = '';
      let searchUrl = '';
      let finalFlights = [];
      let pricingMode = itinerary.tripType === 'multi-city' ? 'separate' : 'standard';
      let activeSegmentIndex = null;
      let activeStepFlights = [];
      let activeStepScope = '';
      let combinedBundles = [];
      let combinedBranchWidth = 0;

      if (combined && itinerary.tripType !== 'multi-city') {
        throw new ArgumentError('--combined only applies to multi-city searches created with --segments');
      }

      if (itinerary.tripType === 'multi-city' && combined) {
        const result = await collectCombinedBundlesForItinerary(
          itinerary,
          browser.endpoint,
          limit
        );
        title = result.title;
        searchUrl = result.searchUrl;
        finalFlights = result.rows;
        combinedBundles = result.bundles;
        combinedBranchWidth = result.branchWidth;
        pricingMode = 'combined';
      } else if (itinerary.tripType === 'multi-city') {
        const result = await collectFlightsForSegments(
          itinerary.segments,
          browser.endpoint,
          itinerary.tripType,
          limit
        );
        title = result.title;
        searchUrl = result.searchUrl;
        finalFlights = result.flights;
      } else if (itinerary.tripType === 'round-trip') {
        const result = await collectCombinedBundlesForItinerary(
          itinerary,
          browser.endpoint,
          limit
        );
        title = result.title;
        searchUrl = result.searchUrl;
        finalFlights = result.rows;
        combinedBundles = result.bundles;
        combinedBranchWidth = result.branchWidth;
        pricingMode = 'combined';
      } else {
        const result = await collectFlightsForItinerary(itinerary, browser.endpoint, itinerary.tripType, limit);
        title = result.title;
        searchUrl = result.searchUrl;
        finalFlights = result.flights;
      }

      if (!finalFlights.length) {
        throw new EmptyResultError(
          'google-flights search',
          `No flight offers were parsed from the generated search${title ? ` (${title})` : ''}.`
        );
      }

      if (kwargs.api) {
        process.stdout.write(`${JSON.stringify(
          combinedBundles.length
            ? buildCombinedApiPayload(itinerary, searchUrl, title, combinedBundles, finalFlights, { pricingMode, branchWidth: combinedBranchWidth })
            : buildApiPayload(
              itinerary,
              searchUrl,
              title,
              finalFlights,
              { pricingMode, activeSegmentIndex, activeStepFlights, activeStepScope }
            ),
          null,
          2
        )}\n`);
        return null;
      }

      return finalFlights;
    } finally {
      await browser.cleanup();
    }
  },
});
