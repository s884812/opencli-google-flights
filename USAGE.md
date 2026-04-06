# Google Flights OpenCLI Usage

This document describes the current behavior of the `google-flights` adapter in `/Users/s884812/.opencli/clis/google-flights`.

Last checked against code and live command output on `2026-04-05`.

Localized copies:

- Traditional Chinese: `USAGE.zh-TW.md`
- Simplified Chinese: `USAGE.zh-CN.md`

## Commands

This adapter currently exposes 2 commands:

```bash
opencli google-flights search ...
opencli google-flights results <url> ...
```

## Requirements

`search` uses a live Google Flights browser session through CDP.

- If `OPENCLI_CDP_ENDPOINT` is set, `search` connects to that endpoint.
- Otherwise it launches an isolated headless Chrome session automatically.

Example:

```bash
OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9222 opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22
```

`results` does not need CDP. It only fetches and parses an existing Google Flights result URL.

## `search`

### Syntax

One-way:

```bash
opencli google-flights search --from <origin> --to <destination> --depart YYYY-MM-DD
```

Round-trip:

```bash
opencli google-flights search --from <origin> --to <destination> --depart YYYY-MM-DD --return YYYY-MM-DD
```

Multi-city, separate pricing mode:

```bash
opencli google-flights search --segments 'Origin>Destination@YYYY-MM-DD;Origin>Destination@YYYY-MM-DD'
```

Multi-city, combined pricing mode:

```bash
opencli google-flights search --segments 'Origin>Destination@YYYY-MM-DD;Origin>Destination@YYYY-MM-DD' --combined
```

### Adapter-specific arguments

| Argument | Required | Applies to | Meaning |
|---|---|---|---|
| `--from` | Yes for single-trip mode | one-way, round-trip | Origin, as a city name or IATA airport code |
| `--to` | Yes for single-trip mode | one-way, round-trip | Destination, as a city name or IATA airport code |
| `--depart` | Yes for single-trip mode | one-way, round-trip | Departure date, `YYYY-MM-DD` |
| `--return` | No | round-trip | Return date, `YYYY-MM-DD` |
| `--segments` | Yes for multi-city mode | multi-city | Semicolon-separated itinerary |
| `--limit` | No | all | Number of returned rows, default `10`, max `50` |
| `--combined` | No | multi-city only | Use Google Flights native multi-city combined pricing |
| `--api` | No | all | Print adapter-defined JSON payload instead of normal row output |

### Location input support

`--from`, `--to`, and multi-city `--segments` origins and destinations accept either:

- city names, such as `Taipei` or `Singapore`
- IATA airport codes, such as `TPE` or `SIN`

Examples:

```bash
opencli google-flights search --from Taipei --to Singapore --depart 2026-11-24
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
opencli google-flights search --from Taipei --to SIN --depart 2026-11-24 --return 2027-01-07
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07'
```

Notes:

- City names usually let Google Flights resolve the city and its airports
- IATA airport codes are more specific and are the better choice when you want a fixed airport
- The adapter passes your location text to Google Flights autocomplete, so final resolution still depends on what Google accepts for that search
- When `OPENCLI_CDP_ENDPOINT` is used with a visible Chrome session, IATA-code itineraries are usually more stable because the adapter can often go directly to a result URL

Normal `search` row output uses these columns:

```text
segment_index  segment_route  rank  price  airline  flight_number  stops  departures  duration  from_airport  to_airport
```

Notes:

- `segment_index` and `segment_route` are populated whenever output is expanded per segment
- In one-way mode, those 2 columns are typically empty
- `departures` is display-oriented; combined rows list each leg's departure time, while `depart` and `arrive` remain available in `--api`

### Multi-city segment format

`--segments` supports `>` and `->`:

```bash
'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22'
'Tokyo -> Sapporo @ 2026-04-16; Sapporo -> Osaka @ 2026-04-22'
```

Rules:

- Minimum `2` segments
- Maximum `6` segments
- Must not be mixed with `--from`, `--to`, `--depart`, or `--return`
- `Origin` and `Destination` can be city names or IATA airport codes
- Each segment must be `Origin>Destination@YYYY-MM-DD`

### Search modes

#### 1. One-way

Example:

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22
```

Using IATA airport codes:

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
```

With `--api`:

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 --limit 1 --api
```

Current payload shape:

```json
{
  "trip_type": "one-way",
  "pricing_mode": "standard",
  "search_url": "...",
  "title": "Tokyo to Sapporo | Google Flights",
  "total_flights": 1,
  "query": {
    "segments": [
      {
        "segment_index": 1,
        "route": "Tokyo -> Sapporo",
        "origin": "Tokyo",
        "destination": "Sapporo",
        "date": "2026-04-22"
      }
    ],
    "from": "Tokyo",
    "to": "Sapporo",
    "depart": "2026-04-22"
  },
  "flights": [
    {
      "rank": 1,
      "price": "5,750",
      "price_value": 5750,
      "airline": "Jetstar",
      "flight_number": "GK 119",
      "stops": "nonstop",
      "depart": "2026-04-15 18:15",
      "arrive": "2026-04-15 20:10",
      "duration": "1 hr 55 min",
      "from_airport": "Narita International Airport (NRT)",
      "to_airport": "New Chitose Airport (CTS)",
      "summary": "...",
      "search_url": "...",
      "trip_type": "one-way"
    }
  ]
}
```

#### 2. Round-trip

Example:

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-18 --return 2026-04-24
```

Using IATA airport codes:

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07
```

With `--api`:

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-18 --return 2026-04-24 --limit 1 --api
```

Round-trip adds:

- `trip_type: "round-trip"`
- `pricing_mode: "combined"`
- `results_scope: "combined-bundles"`
- `query.return`
- `query.segments` contains outbound and return legs
- main `flights` rows are stitched round-trip bundles
- `bundles` repeats the same bundle objects for programmatic access
- `combined_branch_width` is included in `--api` output

#### 3. Multi-city, separate pricing mode

This is the default behavior when `--segments` is used without `--combined`.

Example:

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22'
```

Using IATA airport codes:

```bash
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07'
```

With `--api`:

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --limit 1 --api
```

Current behavior:

- Each segment is searched as its own one-way leg
- Returned flight rows are flattened into one `flights` array
- Each row is tagged with `segment_index` and `segment_route`
- JSON also includes a grouped `segments[].flights`

Current payload shape:

```json
{
  "trip_type": "multi-city",
  "pricing_mode": "separate",
  "search_url": "...",
  "title": "Tokyo to Sapporo | Google Flights",
  "total_flights": 2,
  "query": {
    "segments": [
      {
        "segment_index": 1,
        "route": "Tokyo -> Sapporo",
        "origin": "Tokyo",
        "destination": "Sapporo",
        "date": "2026-04-16"
      },
      {
        "segment_index": 2,
        "route": "Sapporo -> Osaka",
        "origin": "Sapporo",
        "destination": "Osaka",
        "date": "2026-04-22"
      }
    ]
  },
  "flights": [
    {
      "rank": 1,
      "price": "5,750",
      "price_value": 5750,
      "airline": "Jetstar",
      "flight_number": "GK 119",
      "stops": "nonstop",
      "depart": "2026-04-15 18:15",
      "arrive": "2026-04-15 20:10",
      "duration": "1 hr 55 min",
      "from_airport": "Narita International Airport (NRT)",
      "to_airport": "New Chitose Airport (CTS)",
      "summary": "...",
      "search_url": "...",
      "trip_type": "multi-city",
      "segment_index": 1,
      "segment_route": "Tokyo -> Sapporo"
    },
    {
      "rank": 1,
      "price": "7,850",
      "price_value": 7850,
      "airline": "Peach Aviation",
      "flight_number": "MM 118",
      "stops": "nonstop",
      "depart": "2026-04-22 19:10",
      "arrive": "2026-04-22 21:30",
      "duration": "2 hr 20 min",
      "from_airport": "New Chitose Airport (CTS)",
      "to_airport": "Kansai International Airport (KIX)",
      "summary": "...",
      "search_url": "...",
      "trip_type": "multi-city",
      "segment_index": 2,
      "segment_route": "Sapporo -> Osaka"
    }
  ],
  "search_urls": [
    "...",
    "..."
  ],
  "active_segment_index": 1,
  "active_segment_route": "Tokyo -> Sapporo",
  "results_scope": "per-segment",
  "segments": [
    {
      "segment_index": 1,
      "route": "Tokyo -> Sapporo",
      "origin": "Tokyo",
      "destination": "Sapporo",
      "date": "2026-04-16",
      "search_url": "...",
      "flights": [
        {
          "rank": 1,
          "price": "5,750",
          "price_value": 5750,
          "airline": "Jetstar",
          "flight_number": "GK 119",
          "stops": "nonstop",
          "depart": "2026-04-15 18:15",
          "arrive": "2026-04-15 20:10",
          "duration": "1 hr 55 min",
          "from_airport": "Narita International Airport (NRT)",
          "to_airport": "New Chitose Airport (CTS)",
          "summary": "...",
          "search_url": "...",
          "trip_type": "multi-city",
          "segment_index": 1,
          "segment_route": "Tokyo -> Sapporo"
        }
      ]
    },
    {
      "segment_index": 2,
      "route": "Sapporo -> Osaka",
      "origin": "Sapporo",
      "destination": "Osaka",
      "date": "2026-04-22",
      "search_url": "...",
      "flights": [
        {
          "rank": 1,
          "price": "7,850",
          "price_value": 7850,
          "airline": "Peach Aviation",
          "flight_number": "MM 118",
          "stops": "nonstop",
          "depart": "2026-04-22 19:10",
          "arrive": "2026-04-22 21:30",
          "duration": "2 hr 20 min",
          "from_airport": "New Chitose Airport (CTS)",
          "to_airport": "Kansai International Airport (KIX)",
          "summary": "...",
          "search_url": "...",
          "trip_type": "multi-city",
          "segment_index": 2,
          "segment_route": "Sapporo -> Osaka"
        }
      ]
    }
  ]
}
```

#### 4. Multi-city, combined pricing mode

This mode uses Google Flights native multi-city flow.

Example:

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --combined
```

Using IATA airport codes:

```bash
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07' --combined
```

With `--api`:

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --combined --limit 3 --api
```

Current behavior:

- `--combined` only works with `--segments`
- `pricing_mode` becomes `"combined"`
- Returned `flights` are true stitched itinerary bundles, not separate one-way leg rows
- Each combined row carries the full itinerary in `segment_route`, `flight_number`, and `segments`
- For `3+` multi-city legs, the adapter now uses an API-first combined runner instead of waiting on Google’s live DOM cards
- JSON still includes all requested `query.segments`

Important:

- Combined mode now returns itinerary bundles as the main result
- For `3+` multi-city legs, `booking_provider` and `booking_url` may be empty because the adapter is deriving final bundle totals from Google shopping steps before the provider handoff page
- The combined runner currently explores a bounded branch width for stability, so it returns practical cheapest bundles rather than an exhaustive matrix of every possible branch

### `--api` reference

`--api` prints a JSON payload directly to stdout. It does not require OpenCLI `--format json`.

Fields always present:

| Field | Type | Meaning |
|---|---|---|
| `trip_type` | string | `one-way`, `round-trip`, or `multi-city` |
| `pricing_mode` | string | `standard`, `separate`, or `combined` |
| `search_url` | string | Final Google Flights URL used for parsing |
| `title` | string | HTML title of the parsed result page |
| `total_flights` | number | Number of rows in `flights` |
| `query.segments` | array | Requested itinerary segments; round-trip includes outbound and return legs |
| `flights` | array | Flattened returned rows |

Fields present only for non-multi-city:

| Field | Type | Meaning |
|---|---|---|
| `query.from` | string | Requested origin |
| `query.to` | string | Requested destination |
| `query.depart` | string | Requested depart date |
| `query.return` | string | Requested return date, round-trip only |

Fields present for round-trip and multi-city when segment-expanded output is used:

| Field | Type | Meaning |
|---|---|---|
| `results_scope` | string | `"per-segment"` for separate pricing, `"combined-bundles"` for bundled multi-city combined output |
| `segments` | array | Grouped segment entries; in combined-bundle mode these are the requested query segments, while each bundle row carries its own nested `segments` detail |

Fields present only for multi-city:

| Field | Type | Meaning |
|---|---|---|
| `search_urls` | array | Distinct parsed URLs from returned rows in separate-pricing mode |
| `active_segment_index` | number or `null` | 1-based active segment in separate-pricing mode |
| `active_segment_route` | string | Route label for the active segment in separate-pricing mode |
| `results_scope` | string | `"per-segment"` or `"combined-bundles"` |
| `total_bundles` | number | Present in combined-bundle mode |
| `bundles` | array | Present in combined-bundle mode; same stitched itinerary objects as the main combined result set |
| `combined_branch_width` | number | Branch width used by the combined bundle explorer |

Flight row fields returned by `search --api`:

| Field | Appears in | Meaning |
|---|---|---|
| `rank` | all rows | 1-based rank within that parsed result list |
| `price` | all rows | Human-readable price |
| `price_value` | all rows | Numeric price |
| `airline` | all rows | Airline name or names |
| `flight_number` | all rows | Flight number or comma-separated numbers |
| `stops` | all rows | `nonstop`, `1 stop`, `2 stops`, etc. |
| `departures` | all rows from `search` | Display-oriented departure times; combined bundle rows list one departure per leg |
| `depart` | all rows | Parsed departure datetime |
| `arrive` | all rows | Parsed arrival datetime |
| `duration` | all rows | Human-readable duration |
| `from_airport` | all rows | Origin airport name and code |
| `to_airport` | all rows | Destination airport name and code |
| `summary` | all rows | Concise summary string |
| `search_url` | all rows from `search` | Parsed source URL for that row |
| `trip_type` | all rows from `search` | Same mode as top-level payload |
| `segment_index` | round-trip and multi-city expanded rows | 1-based segment index |
| `segment_route` | round-trip and multi-city expanded rows | `Origin -> Destination` |
| `booking_provider` | combined bundle rows | Booking provider when Google exposes it; may be empty in API-first combined mode |
| `booking_url` | combined bundle rows | Booking URL when Google exposes it; may be empty in API-first combined mode |
| `segments` | combined bundle rows | Nested stitched per-leg detail for the full itinerary |

### Validation and error rules

The adapter currently enforces:

- `--depart`, `--return`, and segment dates must be real `YYYY-MM-DD` dates
- `--return` cannot be earlier than `--depart`
- `--combined` cannot be used without `--segments`
- Multi-city must contain `2` to `6` segments
- Segment syntax must be `Origin>Destination@YYYY-MM-DD`

Examples:

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 --combined
```

Returns:

```text
❌ --combined only applies to multi-city searches created with --segments
```

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22;Osaka>Tokyo@2026-04-30;Tokyo>Fukuoka@2026-05-02;Fukuoka>Tokyo@2026-05-05;Tokyo>Okinawa@2026-05-10;Okinawa>Tokyo@2026-05-15'
```

Returns:

```text
❌ Multi-city search supports at most 6 segments
```

If a date is beyond Google’s currently selectable calendar window, the adapter now returns an explicit message instead of a generic page-structure error. Example:

```text
❌ Google Flights currently exposes dates through 2027-02-28; 2027-03-15 is not selectable yet
```

The exact max date is dynamic and depends on when you run the command.

## `results`

### Syntax

```bash
opencli google-flights results '<google-flights-url>' [--limit N]
```

### Arguments

| Argument | Required | Meaning |
|---|---|---|
| `url` | Yes | Absolute Google Flights URL |
| `--limit` | No | Number of returned rows, default `10`, max `50` |

Accepted URL forms:

- `https://www.google.com/travel/flights?...tfs=...`
- `https://www.google.com/travel/flights/search?...tfs=...`

The URL must:

- be absolute
- point to a Google hostname
- point to a Google Flights path
- include a `tfs` query when using `/travel/flights`

### Example

```bash
opencli google-flights results 'https://www.google.com/travel/flights/search?tfs=CBwQAhopEgoyMDI2LTA0LTIyag0IAxIJL20vMGdwNWw2cgwIAxIIL20vMGRxeXdAAUgBcAGCAQsI____________AZgBAg&tfu=EgYIABAAGAA&hl=en' --limit 1
```

Current output shape:

```text
Rank  Price  Airline  Flight_number  Stops    Depart             Arrive             Duration     From_airport                    To_airport
1     5,830  Jetstar  GK 156         nonstop  2026-04-22 16:40   2026-04-22 19:00   2 hr 20 min New Chitose Airport (CTS)     Kansai International Airport (KIX)
```

`results` returns parsed row objects only. It does not define its own `--api` flag.

## OpenCLI global formatting

Besides adapter-specific flags, OpenCLI itself supports global output formatting. For example:

```bash
opencli google-flights results '<google-flights-url>' -f json
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 -f table
```

Use `--api` when you want the richer adapter-defined JSON payload documented above. Use OpenCLI global `-f/--format` when you only want the normal returned rows serialized differently.

## Current limitations

These are current implementation notes, not desired future behavior:

- `search` relies on live Google Flights UI automation and can break if Google changes the page structure.
- `3+` leg multi-city `--combined` now derives bundle totals by replaying Google shopping steps; this is much more accurate than summing separate one-way legs, but it still uses a bounded search rather than enumerating every possible branch.
- `booking_provider` and `booking_url` are currently most reliable for DOM-walked flows; API-first `3+` leg combined mode may leave them blank.
- In current live tests, `query.*` reliably preserves what you asked for, but `search_url` and `flights[*]` can still reflect the final result set Google actually resolved to. This means the returned rows may not always line up perfectly with the originally requested dates or route labels.
- `results` is best when you already have a known Google Flights result URL and want to parse that page repeatably.

## Recommended usage patterns

- Use `search` for live browser-driven queries.
- Use `search --api` when another program needs a structured payload.
- Use city names when you want Google Flights to resolve a broader city-level search.
- Use IATA airport codes when you want to lock the search to a specific airport such as `TPE`, `SIN`, or `NRT`.
- Use default multi-city mode when you want each leg broken out separately.
- Use `--combined` when you want Google’s bundled multi-city pricing instead of summing separate one-way legs.
- Use `results` when you already trust the URL and only need page parsing.
