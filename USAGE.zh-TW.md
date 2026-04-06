# Google Flights OpenCLI 使用說明（繁體中文）

本文件說明 `/Users/s884812/.opencli/clis/google-flights` 內 `google-flights` adapter 的目前行為。

已於 `2026-04-05` 依照程式碼與實際指令輸出再次核對。

## 指令

這個 adapter 目前提供 2 個指令：

```bash
opencli google-flights search ...
opencli google-flights results <url> ...
```

## 執行需求

`search` 會透過 CDP 使用即時的 Google Flights 瀏覽器工作階段。

- 若設定了 `OPENCLI_CDP_ENDPOINT`，`search` 會直接連到該 endpoint
- 若未設定，adapter 會自動啟動一個隔離的 headless Chrome

範例：

```bash
OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9222 opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22
```

`results` 不需要 CDP。它只會抓取並解析既有的 Google Flights 結果網址。

## `search`

### 語法

單程：

```bash
opencli google-flights search --from <origin> --to <destination> --depart YYYY-MM-DD
```

來回：

```bash
opencli google-flights search --from <origin> --to <destination> --depart YYYY-MM-DD --return YYYY-MM-DD
```

多段，分段計價模式：

```bash
opencli google-flights search --segments 'Origin>Destination@YYYY-MM-DD;Origin>Destination@YYYY-MM-DD'
```

多段，Google Flights 合併計價模式：

```bash
opencli google-flights search --segments 'Origin>Destination@YYYY-MM-DD;Origin>Destination@YYYY-MM-DD' --combined
```

### Adapter 專用參數

| 參數 | 是否必填 | 適用模式 | 說明 |
|---|---|---|---|
| `--from` | 單行程模式必填 | 單程、來回 | 出發地，可為城市名或 IATA 機場代碼 |
| `--to` | 單行程模式必填 | 單程、來回 | 目的地，可為城市名或 IATA 機場代碼 |
| `--depart` | 單行程模式必填 | 單程、來回 | 出發日期，格式 `YYYY-MM-DD` |
| `--return` | 否 | 來回 | 回程日期，格式 `YYYY-MM-DD` |
| `--segments` | 多段模式必填 | 多段 | 以分號分隔的行程段落 |
| `--limit` | 否 | 全部 | 回傳列數，預設 `10`，上限 `50` |
| `--combined` | 否 | 僅多段 | 使用 Google Flights 原生 multi-city 合併計價 |
| `--api` | 否 | 全部 | 直接輸出 adapter 定義的 JSON payload，而不是一般列資料 |

### 地點輸入支援

`--from`、`--to` 與多段 `--segments` 的起訖點都支援：

- 城市名稱，例如 `Taipei`、`Singapore`
- IATA 機場代碼，例如 `TPE`、`SIN`

範例：

```bash
opencli google-flights search --from Taipei --to Singapore --depart 2026-11-24
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
opencli google-flights search --from Taipei --to SIN --depart 2026-11-24 --return 2027-01-07
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07'
```

補充說明：

- 城市名稱通常會讓 Google Flights 自動展開對應城市與機場範圍
- IATA 機場代碼更精確，適合你想鎖定特定機場時使用
- Adapter 會把你的輸入交給 Google Flights autocomplete，因此最終採用哪個地點仍取決於 Google 的解析結果
- 若你是用 `OPENCLI_CDP_ENDPOINT` 連接自己的可見 Chrome，使用 IATA 機場代碼通常更穩，因為 adapter 常可直接跳到結果網址

一般 `search` 列輸出會使用以下欄位：

```text
segment_index  segment_route  rank  price  airline  flight_number  stops  departures  duration  from_airport  to_airport
```

補充：

- 只要結果是按 segment 展開，`segment_index` 與 `segment_route` 就會有值
- 單程模式通常不會填這兩個欄位
- `departures` 是給一般表格看的欄位；combined row 會列出每段的出發時間，`depart` 與 `arrive` 仍保留在 `--api` 資料中

### 多段 `--segments` 格式

`--segments` 同時接受 `>` 與 `->`：

```bash
'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22'
'Tokyo -> Sapporo @ 2026-04-16; Sapporo -> Osaka @ 2026-04-22'
```

規則：

- 最少 `2` 段
- 最多 `6` 段
- 不可與 `--from`、`--to`、`--depart`、`--return` 混用
- `Origin` 與 `Destination` 可用城市名或 IATA 機場代碼
- 每段都必須符合 `Origin>Destination@YYYY-MM-DD`

### 搜尋模式

#### 1. 單程

範例：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22
```

使用 IATA 機場代碼：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
```

搭配 `--api`：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 --limit 1 --api
```

目前行為：

- `trip_type` 會是 `one-way`
- `pricing_mode` 會是 `standard`
- `query.from`、`query.to`、`query.depart` 會保留原始查詢
- `flights` 會是單程結果列的扁平陣列

#### 2. 來回

範例：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-18 --return 2026-04-24
```

使用 IATA 機場代碼：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07
```

搭配 `--api`：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07 --limit 1 --api
```

目前行為：

- `trip_type` 會是 `round-trip`
- `pricing_mode` 會是 `combined`
- `results_scope` 會是 `"combined-bundles"`
- `query.return` 會出現在 payload 中
- `query.segments` 會包含去程與回程兩段
- 主體 `flights` 會是已拼好的 round-trip bundle，而不是單獨 leg rows
- `bundles` 會再提供同一批 bundle 物件，方便程式端直接取用
- `combined_branch_width` 會出現在 `--api` 輸出中

#### 3. 多段，分段計價模式

這是 `--segments` 未搭配 `--combined` 時的預設行為。

範例：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22'
```

使用 IATA 機場代碼：

```bash
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07'
```

搭配 `--api`：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --limit 1 --api
```

目前行為：

- 每一段都會分別以 one-way 搜尋
- 回傳的 `flights` 會被攤平成一個陣列
- 每列都會標註 `segment_index` 與 `segment_route`
- JSON 另外會提供依段落分組的 `segments[].flights`
- `results_scope` 會是 `"per-segment"`

#### 4. 多段，合併計價模式

這個模式會使用 Google Flights 原生 multi-city 流程。

範例：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --combined
```

使用 IATA 機場代碼：

```bash
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07' --combined
```

搭配 `--api`：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --combined --limit 3 --api
```

目前行為：

- `--combined` 只能搭配 `--segments`
- `pricing_mode` 會是 `"combined"`
- `results_scope` 會是 `"combined-bundles"`
- 主體 `flights` 會是完整 itinerary bundle，不是各段拆開的一程票
- 每一列 bundle 都會把整段行程收進 `segment_route`、`flight_number` 與巢狀 `segments`
- `3+` 段 multi-city 目前會優先走 API-first combined runner，而不是只等 Google 頁面上的 live cards
- `query.segments` 仍會完整保留原始請求的段落

重要說明：

- 合併模式目前回傳的是 itinerary bundle，這就是主要結果集
- 對 `3+` 段 multi-city 而言，`booking_provider` 與 `booking_url` 可能為空，因為目前是先從 Google shopping steps 推得 bundle total，尚未一定走到 provider handoff 頁
- combined runner 目前使用有上限的 branch width 來換取穩定性，因此它回的是實用的便宜組合，不是無上限列舉所有分支

### `--api` 參考

`--api` 會直接把 JSON payload 輸出到 stdout，不需要再加 OpenCLI 全域 `--format json`。

永遠會出現的欄位：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `trip_type` | string | `one-way`、`round-trip`、`multi-city` |
| `pricing_mode` | string | `standard`、`separate`、`combined` |
| `search_url` | string | 解析結果所對應的最終 Google Flights URL |
| `title` | string | 解析頁面的 HTML title |
| `total_flights` | number | `flights` 陣列中的列數 |
| `query.segments` | array | 請求的 itinerary 段落；來回會包含去程與回程 |
| `flights` | array | 扁平化後的回傳列 |

僅在非 multi-city 查詢中出現：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `query.from` | string | 請求的出發地 |
| `query.to` | string | 請求的目的地 |
| `query.depart` | string | 請求的出發日期 |
| `query.return` | string | 請求的回程日期，僅來回模式 |

僅在來回與 bundle 型 combined 輸出中出現：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `results_scope` | string | 目前為 `"combined-bundles"` |
| `total_bundles` | number | bundle 數量 |
| `bundles` | array | 與主結果相同的一批 stitched itinerary bundle 物件 |
| `segments` | array | 請求的 query segments；每個 bundle row 另外還會有自己的巢狀 `segments` 細節 |
| `combined_branch_width` | number | combined bundle explorer 使用的 branch width |

僅在 multi-city 分段模式中出現：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `search_urls` | array | 分段模式下，不同 leg 對應的 distinct parsed URLs |
| `active_segment_index` | number 或 `null` | 分段模式下的 active segment，1-based |
| `active_segment_route` | string | active segment 的路線標籤 |
| `results_scope` | string | `"per-segment"` |
| `segments` | array | 依照 segment 分組的結果，每段有自己的 `flights` |

`search --api` 回傳的 flight row 欄位：

| 欄位 | 出現位置 | 說明 |
|---|---|---|
| `rank` | 全部列 | 該解析結果清單中的 1-based 排名 |
| `price` | 全部列 | 人類可讀價格 |
| `price_value` | 全部列 | 數值化價格 |
| `airline` | 全部列 | 航空公司名稱 |
| `flight_number` | 全部列 | 航班號，或多段時以 `|` 串接 |
| `stops` | 全部列 | `nonstop`、`1 stop`、`2 stops` 等 |
| `departures` | `search` 的全部列 | 給一般表格看的出發時間；combined bundle rows 會列出每段出發時間 |
| `depart` | 全部列 | 解析出的出發日期時間 |
| `arrive` | 全部列 | 解析出的抵達日期時間 |
| `duration` | 全部列 | 人類可讀飛行時間 |
| `from_airport` | 全部列 | 出發機場名稱與代碼 |
| `to_airport` | 全部列 | 抵達機場名稱與代碼 |
| `summary` | 全部列 | 簡短摘要字串 |
| `search_url` | `search` 的全部列 | 該列對應的來源 URL |
| `trip_type` | `search` 的全部列 | 與頂層 payload 相同的模式 |
| `segment_index` | segment 展開列 | 1-based segment 索引 |
| `segment_route` | segment 展開列 | `Origin -> Destination` |
| `booking_provider` | combined bundle rows | Google 有曝光時會帶出；API-first combined 可能為空 |
| `booking_url` | combined bundle rows | Google 有曝光時會帶出；API-first combined 可能為空 |
| `segments` | combined bundle rows | 這個完整 itinerary 的巢狀逐段細節 |

### 驗證與錯誤規則

目前 adapter 會檢查：

- `--depart`、`--return` 與各 segment 日期必須是真實存在的 `YYYY-MM-DD`
- `--return` 不可早於 `--depart`
- `--combined` 不能脫離 `--segments` 單獨使用
- multi-city 必須有 `2` 到 `6` 段
- segment 語法必須是 `Origin>Destination@YYYY-MM-DD`

範例：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 --combined
```

回傳：

```text
❌ --combined only applies to multi-city searches created with --segments
```

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22;Osaka>Tokyo@2026-04-30;Tokyo>Fukuoka@2026-05-02;Fukuoka>Tokyo@2026-05-05;Tokyo>Okinawa@2026-05-10;Okinawa>Tokyo@2026-05-15'
```

回傳：

```text
❌ Multi-city search supports at most 6 segments
```

若日期超出 Google 當前月曆可選範圍，adapter 會回明確錯誤，而不是模糊的頁面結構錯誤。範例：

```text
❌ Google Flights currently exposes dates through 2027-02-28; 2027-03-15 is not selectable yet
```

實際最大日期會隨你執行指令的時間而變動。

## `results`

### 語法

```bash
opencli google-flights results '<google-flights-url>' [--limit N]
```

### 參數

| 參數 | 是否必填 | 說明 |
|---|---|---|
| `url` | 是 | 完整 Google Flights URL |
| `--limit` | 否 | 回傳列數，預設 `10`，上限 `50` |

可接受的網址形式：

- `https://www.google.com/travel/flights?...tfs=...`
- `https://www.google.com/travel/flights/search?...tfs=...`

網址必須同時滿足：

- 必須是 absolute URL
- host 必須是 Google
- path 必須是 Google Flights 路徑
- 若使用 `/travel/flights`，query 中必須帶有 `tfs`

### 範例

```bash
opencli google-flights results 'https://www.google.com/travel/flights/search?tfs=CBwQAhopEgoyMDI2LTA0LTIyag0IAxIJL20vMGdwNWw2cgwIAxIIL20vMGRxeXdAAUgBcAGCAQsI____________AZgBAg&tfu=EgYIABAAGAA&hl=en' --limit 1
```

目前輸出形狀：

```text
Rank  Price  Airline  Flight_number  Stops    Depart             Arrive             Duration     From_airport                    To_airport
1     5,830  Jetstar  GK 156         nonstop  2026-04-22 16:40   2026-04-22 19:00   2 hr 20 min New Chitose Airport (CTS)     Kansai International Airport (KIX)
```

`results` 只會回 parsed row objects，不提供自己的 `--api` 旗標。

## OpenCLI 全域格式化

除了 adapter 專用旗標外，OpenCLI 本身也支援全域輸出格式，例如：

```bash
opencli google-flights results '<google-flights-url>' -f json
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 -f table
```

若你需要較豐富、adapter 自定義的 JSON payload，請用 `--api`。若你只是想把一般回傳列轉成 `json`、`yaml`、`csv` 或 `table`，請用 OpenCLI 全域 `-f/--format`。

## 目前限制

以下是目前實作狀態，不是未來理想行為：

- `search` 依賴即時 Google Flights UI 自動化，因此若 Google 改版，流程可能失效
- `3+` 段 multi-city `--combined` 目前是透過 replay Google shopping steps 推導 bundle total；這比單純把各段 one-way 相加準確得多，但仍是 bounded search，不是列舉所有可能分支
- `booking_provider` 與 `booking_url` 對 DOM-walked flows 最可靠；API-first 的 `3+` 段 combined 可能留空
- 目前 live 測試中，`query.*` 很穩定地保留原始查詢；但 `search_url` 與 `flights[*]` 仍可能反映 Google 最終實際解出的結果，因此回傳列不一定和原始要求的日期或 route label 完全一致
- `results` 最適合用在你已經有可信的 Google Flights 結果網址，只需要穩定解析該頁面時

## 建議使用方式

- 需要即時、瀏覽器驅動的查詢時，用 `search`
- 需要程式接資料時，用 `search --api`
- 想讓 Google Flights 自行展開城市層級範圍時，用城市名
- 想把搜尋鎖定在特定機場，例如 `TPE`、`SIN`、`NRT` 時，用 IATA 機場代碼
- 想分段看每一 leg 的候選票時，用預設 multi-city 模式
- 想拿 Google 的 bundled multi-city 價格時，用 `--combined`
- 已經信任某個結果網址，只需要做頁面解析時，用 `results`
