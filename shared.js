import { CliError } from '../../errors.js';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export function clampLimit(raw) {
  const value = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function normalizeText(value) {
  return decodeHtml(value)
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitle(html) {
  const match = html.match(/<title>([^<]+)<\/title>/i);
  return normalizeText(match?.[1] || '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInitData(html, key) {
  const pattern = new RegExp(
    `AF_initDataCallback\\(\\{key:\\s*'${escapeRegExp(key)}',\\s*hash:\\s*'[^']+',\\s*data:(\\[[\\s\\S]*?\\]),\\s*sideChannel:\\s*\\{\\}\\}\\);<\\/script>`
  );
  const match = html.match(pattern);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function looksLikeOffer(value) {
  if (!Array.isArray(value) || value.length < 2) return false;
  const row = value[0];
  const pricing = value[1];
  return (
    Array.isArray(row) &&
    Array.isArray(pricing) &&
    typeof row[0] === 'string' &&
    Array.isArray(row[1]) &&
    Array.isArray(row[2]) &&
    typeof row[3] === 'string' &&
    Array.isArray(row[4]) &&
    Array.isArray(row[5]) &&
    typeof row[6] === 'string' &&
    Array.isArray(pricing[0]) &&
    isFiniteNumber(pricing[0][1])
  );
}

function collectOffers(initData) {
  const offers = [];
  for (const entry of initData || []) {
    const candidateList = Array.isArray(entry) ? entry[0] : null;
    if (!Array.isArray(candidateList) || !candidateList.length) continue;
    if (!candidateList.every(looksLikeOffer)) continue;
    offers.push(...candidateList);
  }
  return offers;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDate(dateParts) {
  if (!Array.isArray(dateParts) || dateParts.length < 3) return '';
  const [year, month, day] = dateParts;
  if (![year, month, day].every(isFiniteNumber)) return '';
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatTime(timeParts) {
  if (!Array.isArray(timeParts) || !timeParts.length) return '';
  const [hour, minute = 0] = timeParts;
  if (![hour, minute].every(isFiniteNumber)) return '';
  return `${pad2(hour)}:${pad2(minute)}`;
}

function formatDateTime(dateParts, timeParts) {
  const date = formatDate(dateParts);
  const time = formatTime(timeParts);
  return [date, time].filter(Boolean).join(' ');
}

function formatDuration(totalMinutes) {
  if (!isFiniteNumber(totalMinutes)) return '';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function formatStops(stopCount) {
  if (!Number.isInteger(stopCount) || stopCount <= 0) return 'nonstop';
  return stopCount === 1 ? '1 stop' : `${stopCount} stops`;
}

function formatPrice(priceValue) {
  if (!isFiniteNumber(priceValue)) return '';
  return new Intl.NumberFormat('en-US').format(priceValue);
}

function formatAirport(name, code) {
  const airportName = normalizeText(name);
  const airportCode = normalizeText(code);
  if (airportName && airportCode) return `${airportName} (${airportCode})`;
  return airportName || airportCode;
}

function extractFlightNumbers(segments) {
  const values = [];
  for (const segment of segments || []) {
    if (!Array.isArray(segment)) continue;
    const code = normalizeText(segment[22]?.[0] || '');
    const number = normalizeText(segment[22]?.[1] || '');
    if (code && number) {
      values.push(`${code} ${number}`);
    } else if (number) {
      values.push(number);
    } else if (code) {
      values.push(code);
    }
  }
  return [...new Set(values)].join(', ');
}

function parseOffer(offer, rank) {
  if (!looksLikeOffer(offer)) return null;

  const row = offer[0];
  const priceValue = offer[1][0][1];
  const segments = row[2].filter(segment => Array.isArray(segment));
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1] || firstSegment;
  if (!firstSegment || !lastSegment) return null;

  const airlineNames = row[1].map(name => normalizeText(name)).filter(Boolean);
  const airline = [...new Set(airlineNames)].join(', ');
  const flightNumber = extractFlightNumbers(segments);
  const stopCount = Number.isInteger(row[12]) ? row[12] : Math.max(0, segments.length - 1);
  const fromCode = normalizeText(firstSegment[3] || row[3] || '');
  const toCode = normalizeText(lastSegment[6] || row[6] || '');
  const depart = formatDateTime(row[4], row[5]);
  const arrive = formatDateTime(row[7], row[8]);
  const duration = formatDuration(row[9]);
  const price = formatPrice(priceValue);
  const summary = [
    airline,
    flightNumber,
    formatStops(stopCount),
    `${fromCode} ${depart} -> ${toCode} ${arrive}`.trim(),
    duration && `(${duration})`,
    price && `price ${price}`,
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    rank,
    price,
    price_value: priceValue,
    airline,
    flight_number: flightNumber,
    stops: formatStops(stopCount),
    depart,
    arrive,
    duration,
    from_airport: formatAirport(firstSegment[4], fromCode),
    to_airport: formatAirport(lastSegment[5], toCode),
    summary,
  };
}

export function extractFlights(html, limit) {
  const initData = extractInitData(html, 'ds:1');
  if (!Array.isArray(initData)) return [];

  const seen = new Set();
  const flights = [];
  for (const offer of collectOffers(initData)) {
    const id = normalizeText(offer?.[0]?.[17] || offer?.[1]?.[1] || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);

    const parsed = parseOffer(offer, flights.length + 1);
    if (!parsed) continue;
    flights.push(parsed);

    if (flights.length >= limit) break;
  }

  return flights;
}

function extractFirstJsonArray(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseShoppingResultsPayload(rawBody) {
  const body = String(rawBody || '');
  const start = body.indexOf('[[');
  if (start === -1) return null;

  const outerJson = extractFirstJsonArray(body, start);
  if (!outerJson) return null;

  let outer;
  try {
    outer = JSON.parse(outerJson);
  } catch {
    return null;
  }

  const innerJson = outer?.[0]?.[2];
  if (typeof innerJson !== 'string') return null;

  try {
    return JSON.parse(innerJson);
  } catch {
    return null;
  }
}

function looksLikeShoppingResultOffer(value) {
  if (!Array.isArray(value) || value.length < 2) return false;
  const row = value[0];
  const pricing = value[1];

  return (
    Array.isArray(row) &&
    typeof row[0] === 'string' &&
    Array.isArray(row[1]) &&
    Array.isArray(row[2]) &&
    typeof row[3] === 'string' &&
    Array.isArray(row[4]) &&
    Array.isArray(row[5]) &&
    typeof row[6] === 'string' &&
    Array.isArray(row[7]) &&
    Array.isArray(row[8]) &&
    isFiniteNumber(row[9]) &&
    Array.isArray(pricing) &&
    Array.isArray(pricing[0]) &&
    isFiniteNumber(pricing[0][1])
  );
}

function extractShoppingFlightNumbers(segments) {
  const values = [];
  for (const segment of segments || []) {
    if (!Array.isArray(segment)) continue;
    const code = normalizeText(segment[22]?.[0] || '');
    const number = normalizeText(segment[22]?.[1] || '');
    if (code && number) {
      values.push(`${code} ${number}`);
    } else if (number) {
      values.push(number);
    } else if (code) {
      values.push(code);
    }
  }
  return [...new Set(values)].join(', ');
}

function parseShoppingResultOffer(offer, rank) {
  if (!looksLikeShoppingResultOffer(offer)) return null;

  const row = offer[0];
  const priceValue = offer[1][0][1];
  const segments = row[2].filter(segment => Array.isArray(segment));
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1] || firstSegment;
  if (!firstSegment || !lastSegment) return null;

  const airlineNames = row[1].map(name => normalizeText(name)).filter(Boolean);
  const airline = [...new Set(airlineNames)].join(', ');
  const flightNumber = extractShoppingFlightNumbers(segments);
  const stopCount = Math.max(0, segments.length - 1);
  const fromCode = normalizeText(firstSegment[3] || row[3] || '');
  const toCode = normalizeText(lastSegment[6] || row[6] || '');
  const depart = formatDateTime(row[4], row[5]);
  const arrive = formatDateTime(row[7], row[8]);
  const duration = formatDuration(row[9]);
  const price = formatPrice(priceValue);
  const summary = [
    airline,
    flightNumber,
    formatStops(stopCount),
    `${fromCode} ${depart} -> ${toCode} ${arrive}`.trim(),
    duration && `(${duration})`,
    price && `price ${price}`,
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    rank,
    price,
    price_value: priceValue,
    airline,
    flight_number: flightNumber,
    stops: formatStops(stopCount),
    depart,
    arrive,
    duration,
    from_airport: formatAirport(firstSegment[4], fromCode),
    to_airport: formatAirport(lastSegment[5], toCode),
    summary,
  };
}

function collectShoppingResultOffers(rawBody, limit = Number.POSITIVE_INFINITY) {
  const payload = parseShoppingResultsPayload(rawBody);
  const offerContainers = [];
  if (Array.isArray(payload?.[2]?.[0])) offerContainers.push(payload[2][0]);
  if (Array.isArray(payload?.[3]?.[0])) offerContainers.push(payload[3][0]);
  if (!offerContainers.length) return [];

  const offers = [];
  const seen = new Set();
  for (const offerContainer of offerContainers) {
    for (const offer of offerContainer) {
      const parsed = parseShoppingResultOffer(offer, offers.length + 1);
      if (!parsed) continue;

      const id = [
        normalizeText(parsed.airline),
        normalizeText(parsed.flight_number),
        normalizeText(parsed.depart),
        normalizeText(parsed.arrive),
        parsed.price_value,
      ].join('|');
      if (seen.has(id)) continue;
      seen.add(id);

      offers.push(offer);
      if (offers.length >= limit) break;
    }
    if (offers.length >= limit) break;
  }

  return offers;
}

export function extractStructuredShoppingResultOffers(rawBody, limit) {
  return collectShoppingResultOffers(rawBody, limit)
    .map((offer, index) => ({
      offer,
      parsed: parseShoppingResultOffer(offer, index + 1),
    }))
    .filter((item) => item.parsed);
}

export function extractFlightsFromShoppingResultsBody(rawBody, limit) {
  const flights = [];
  for (const item of extractStructuredShoppingResultOffers(rawBody, limit)) {
    flights.push(item.parsed);
    if (flights.length >= limit) break;
  }

  return flights;
}

export async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'curl/8.7.1',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new CliError(
      'FETCH_ERROR',
      `google-flights request failed with status ${response.status}`,
      'Verify the Google Flights URL is valid and reachable'
    );
  }

  return response.text();
}

export function parseGoogleFlightsUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) {
    throw new Error('Google Flights URL cannot be empty');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Google Flights URL must be a valid absolute URL');
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!hostname.startsWith('www.google.') && hostname !== 'google.com' && !hostname.endsWith('.google.com')) {
    throw new Error('URL must point to Google Flights');
  }

  const pathname = parsedUrl.pathname;
  const isFlightsPath = pathname === '/travel/flights' || pathname.startsWith('/travel/flights/search');
  if (!isFlightsPath) {
    throw new Error('URL must be a Google Flights search URL');
  }

  if (pathname === '/travel/flights' && !parsedUrl.searchParams.has('tfs')) {
    throw new Error('URL must include a Google Flights tfs query');
  }

  return parsedUrl;
}
