import { ArgumentError, EmptyResultError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { DEFAULT_LIMIT, MAX_LIMIT, clampLimit, extractFlights, extractTitle, fetchHtml, parseGoogleFlightsUrl } from './shared.js';

cli({
  site: 'google-flights',
  name: 'results',
  description: 'Parse a Google Flights result URL into flight rows',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'url', required: true, positional: true, help: 'Google Flights URL or generated tfs URL' },
    { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Number of rows to return (max ${MAX_LIMIT})` },
  ],
  columns: ['rank', 'price', 'airline', 'flight_number', 'stops', 'depart', 'arrive', 'duration', 'from_airport', 'to_airport'],
  func: async (_page, kwargs) => {
    let parsedUrl;
    try {
      parsedUrl = parseGoogleFlightsUrl(kwargs.url);
    } catch (error) {
      throw new ArgumentError(error instanceof Error ? error.message : 'Invalid Google Flights URL');
    }

    const limit = clampLimit(kwargs.limit);
    const html = await fetchHtml(parsedUrl.toString());
    const title = extractTitle(html);
    const flights = extractFlights(html, limit);

    if (!flights.length) {
      throw new EmptyResultError(
        'google-flights results',
        `No flight offers were parsed from the result page${title ? ` (${title})` : ''}. The page structure may have changed.`
      );
    }

    return flights;
  },
});
