# Google Flights OpenCLI 使用说明（简体中文）

本文档说明 `/Users/s884812/.opencli/clis/google-flights` 中 `google-flights` adapter 的当前行为。

已于 `2026-04-05` 按代码与实际指令输出重新核对。

## 指令

这个 adapter 目前提供 2 个指令：

```bash
opencli google-flights search ...
opencli google-flights results <url> ...
```

## 运行要求

`search` 会通过 CDP 使用实时的 Google Flights 浏览器会话。

- 如果设置了 `OPENCLI_CDP_ENDPOINT`，`search` 会直接连接该 endpoint
- 如果没有设置，adapter 会自动启动一个隔离的 headless Chrome

示例：

```bash
OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9222 opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22
```

`results` 不需要 CDP。它只会抓取并解析已有的 Google Flights 结果 URL。

## `search`

### 语法

单程：

```bash
opencli google-flights search --from <origin> --to <destination> --depart YYYY-MM-DD
```

往返：

```bash
opencli google-flights search --from <origin> --to <destination> --depart YYYY-MM-DD --return YYYY-MM-DD
```

多段，分段计价模式：

```bash
opencli google-flights search --segments 'Origin>Destination@YYYY-MM-DD;Origin>Destination@YYYY-MM-DD'
```

多段，Google Flights 合并计价模式：

```bash
opencli google-flights search --segments 'Origin>Destination@YYYY-MM-DD;Origin>Destination@YYYY-MM-DD' --combined
```

### Adapter 专用参数

| 参数 | 是否必填 | 适用模式 | 说明 |
|---|---|---|---|
| `--from` | 单行程模式必填 | 单程、往返 | 出发地，可为城市名或 IATA 机场代码 |
| `--to` | 单行程模式必填 | 单程、往返 | 目的地，可为城市名或 IATA 机场代码 |
| `--depart` | 单行程模式必填 | 单程、往返 | 出发日期，格式 `YYYY-MM-DD` |
| `--return` | 否 | 往返 | 回程日期，格式 `YYYY-MM-DD` |
| `--segments` | 多段模式必填 | 多段 | 用分号分隔的行程段 |
| `--limit` | 否 | 全部 | 返回行数，默认 `10`，上限 `50` |
| `--combined` | 否 | 仅多段 | 使用 Google Flights 原生 multi-city 合并计价 |
| `--api` | 否 | 全部 | 直接输出 adapter 定义的 JSON payload，而不是普通行结果 |

### 地点输入支持

`--from`、`--to` 和多段 `--segments` 的起终点都支持：

- 城市名称，例如 `Taipei`、`Singapore`
- IATA 机场代码，例如 `TPE`、`SIN`

示例：

```bash
opencli google-flights search --from Taipei --to Singapore --depart 2026-11-24
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
opencli google-flights search --from Taipei --to SIN --depart 2026-11-24 --return 2027-01-07
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07'
```

补充说明：

- 城市名称通常会让 Google Flights 自动扩展对应城市和机场范围
- IATA 机场代码更精确，适合你想锁定具体机场时使用
- Adapter 会把你的输入交给 Google Flights autocomplete，因此最终采用哪个地点仍取决于 Google 的解析结果
- 如果你是用 `OPENCLI_CDP_ENDPOINT` 连接自己的可见 Chrome，使用 IATA 机场代码通常更稳定，因为 adapter 往往可以直接跳到结果 URL

普通 `search` 行输出使用以下列：

```text
segment_index  segment_route  rank  price  airline  flight_number  stops  departures  duration  from_airport  to_airport
```

补充：

- 只要结果是按 segment 展开，`segment_index` 和 `segment_route` 就会有值
- 单程模式通常不会填写这两个字段
- `departures` 是给普通表格显示用的字段；combined row 会列出每段出发时间，`depart` 和 `arrive` 仍保留在 `--api` 数据中

### 多段 `--segments` 格式

`--segments` 同时支持 `>` 和 `->`：

```bash
'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22'
'Tokyo -> Sapporo @ 2026-04-16; Sapporo -> Osaka @ 2026-04-22'
```

规则：

- 最少 `2` 段
- 最多 `6` 段
- 不能与 `--from`、`--to`、`--depart`、`--return` 混用
- `Origin` 和 `Destination` 可以使用城市名或 IATA 机场代码
- 每一段都必须符合 `Origin>Destination@YYYY-MM-DD`

### 搜索模式

#### 1. 单程

示例：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22
```

使用 IATA 机场代码：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
```

搭配 `--api`：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 --limit 1 --api
```

当前行为：

- `trip_type` 为 `one-way`
- `pricing_mode` 为 `standard`
- `query.from`、`query.to`、`query.depart` 会保留原始查询
- `flights` 为单程结果行的扁平数组

#### 2. 往返

示例：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-18 --return 2026-04-24
```

使用 IATA 机场代码：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07
```

搭配 `--api`：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07 --limit 1 --api
```

当前行为：

- `trip_type` 为 `round-trip`
- `pricing_mode` 为 `combined`
- `results_scope` 为 `"combined-bundles"`
- `query.return` 会出现在 payload 中
- `query.segments` 会包含去程和回程两段
- 主体 `flights` 是已拼好的 round-trip bundle，而不是拆开的 leg rows
- `bundles` 会再次提供同一批 bundle 对象，方便程序直接消费
- `combined_branch_width` 会出现在 `--api` 输出中

#### 3. 多段，分段计价模式

这是 `--segments` 未搭配 `--combined` 时的默认行为。

示例：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22'
```

使用 IATA 机场代码：

```bash
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07'
```

搭配 `--api`：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --limit 1 --api
```

当前行为：

- 每一段都会单独以 one-way 搜索
- 返回的 `flights` 会被压平成一个数组
- 每一行都会带上 `segment_index` 和 `segment_route`
- JSON 还会提供按段分组的 `segments[].flights`
- `results_scope` 为 `"per-segment"`

#### 4. 多段，合并计价模式

这个模式会使用 Google Flights 原生 multi-city 流程。

示例：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --combined
```

使用 IATA 机场代码：

```bash
opencli google-flights search --segments 'TPE>SIN@2026-11-24;SIN>TPE@2027-01-07' --combined
```

搭配 `--api`：

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22' --combined --limit 3 --api
```

当前行为：

- `--combined` 只能与 `--segments` 一起使用
- `pricing_mode` 为 `"combined"`
- `results_scope` 为 `"combined-bundles"`
- 主体 `flights` 是完整 itinerary bundle，不是每段单独的一程票
- 每一行 bundle 都会把完整行程写入 `segment_route`、`flight_number` 和嵌套 `segments`
- `3+` 段 multi-city 目前优先走 API-first combined runner，而不是只等待 Google 页面上的 live cards
- `query.segments` 仍会完整保留原始请求的段信息

重要说明：

- 合并模式当前返回的主要结果就是 itinerary bundle
- 对 `3+` 段 multi-city 而言，`booking_provider` 和 `booking_url` 可能为空，因为当前实现是先从 Google shopping steps 推导 bundle total，还不一定会走到 provider handoff 页
- combined runner 当前使用有上限的 branch width 来换稳定性，因此返回的是实用的低价组合，而不是无限枚举所有分支

### `--api` 参考

`--api` 会直接把 JSON payload 打到 stdout，不需要再加 OpenCLI 全局 `--format json`。

始终存在的字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `trip_type` | string | `one-way`、`round-trip`、`multi-city` |
| `pricing_mode` | string | `standard`、`separate`、`combined` |
| `search_url` | string | 解析结果对应的最终 Google Flights URL |
| `title` | string | 解析页面的 HTML title |
| `total_flights` | number | `flights` 数组中的行数 |
| `query.segments` | array | 请求的 itinerary 段；往返会包含去程和回程 |
| `flights` | array | 扁平化后的返回结果行 |

仅在非 multi-city 查询中出现：

| 字段 | 类型 | 说明 |
|---|---|---|
| `query.from` | string | 请求的出发地 |
| `query.to` | string | 请求的目的地 |
| `query.depart` | string | 请求的出发日期 |
| `query.return` | string | 请求的回程日期，仅往返模式 |

仅在往返与 bundle 型 combined 输出中出现：

| 字段 | 类型 | 说明 |
|---|---|---|
| `results_scope` | string | 当前为 `"combined-bundles"` |
| `total_bundles` | number | bundle 数量 |
| `bundles` | array | 与主结果相同的一批 stitched itinerary bundle 对象 |
| `segments` | array | 请求的 query segments；每个 bundle row 另外还会有自己的嵌套 `segments` 明细 |
| `combined_branch_width` | number | combined bundle explorer 使用的 branch width |

仅在 multi-city 分段模式中出现：

| 字段 | 类型 | 说明 |
|---|---|---|
| `search_urls` | array | 分段模式下，不同 leg 对应的 distinct parsed URLs |
| `active_segment_index` | number 或 `null` | 分段模式下的 active segment，1-based |
| `active_segment_route` | string | active segment 的路线标签 |
| `results_scope` | string | `"per-segment"` |
| `segments` | array | 按 segment 分组的结果，每段都有自己的 `flights` |

`search --api` 返回的 flight row 字段：

| 字段 | 出现位置 | 说明 |
|---|---|---|
| `rank` | 全部行 | 该解析结果列表中的 1-based 排名 |
| `price` | 全部行 | 可读价格 |
| `price_value` | 全部行 | 数值价格 |
| `airline` | 全部行 | 航司名称 |
| `flight_number` | 全部行 | 航班号，或多段时以 `|` 拼接 |
| `stops` | 全部行 | `nonstop`、`1 stop`、`2 stops` 等 |
| `departures` | `search` 的全部行 | 给普通表格显示用的出发时间；combined bundle rows 会列出每段出发时间 |
| `depart` | 全部行 | 解析出的出发日期时间 |
| `arrive` | 全部行 | 解析出的到达日期时间 |
| `duration` | 全部行 | 可读时长 |
| `from_airport` | 全部行 | 出发机场名称和代码 |
| `to_airport` | 全部行 | 到达机场名称和代码 |
| `summary` | 全部行 | 简短摘要字符串 |
| `search_url` | `search` 的全部行 | 该行对应的来源 URL |
| `trip_type` | `search` 的全部行 | 与顶层 payload 相同的模式 |
| `segment_index` | segment 展开行 | 1-based segment 索引 |
| `segment_route` | segment 展开行 | `Origin -> Destination` |
| `booking_provider` | combined bundle rows | 当 Google 暴露时会带出；API-first combined 可能为空 |
| `booking_url` | combined bundle rows | 当 Google 暴露时会带出；API-first combined 可能为空 |
| `segments` | combined bundle rows | 该完整 itinerary 的嵌套逐段明细 |

### 校验与错误规则

目前 adapter 会校验：

- `--depart`、`--return` 和各 segment 日期必须是真实存在的 `YYYY-MM-DD`
- `--return` 不能早于 `--depart`
- `--combined` 不能脱离 `--segments` 单独使用
- multi-city 必须有 `2` 到 `6` 段
- segment 语法必须是 `Origin>Destination@YYYY-MM-DD`

示例：

```bash
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 --combined
```

返回：

```text
❌ --combined only applies to multi-city searches created with --segments
```

```bash
opencli google-flights search --segments 'Tokyo>Sapporo@2026-04-16;Sapporo>Osaka@2026-04-22;Osaka>Tokyo@2026-04-30;Tokyo>Fukuoka@2026-05-02;Fukuoka>Tokyo@2026-05-05;Tokyo>Okinawa@2026-05-10;Okinawa>Tokyo@2026-05-15'
```

返回：

```text
❌ Multi-city search supports at most 6 segments
```

如果日期超出 Google 当前日历可选范围，adapter 会返回明确错误，而不是模糊的页面结构错误。示例：

```text
❌ Google Flights currently exposes dates through 2027-02-28; 2027-03-15 is not selectable yet
```

实际最大日期会随执行时间动态变化。

## `results`

### 语法

```bash
opencli google-flights results '<google-flights-url>' [--limit N]
```

### 参数

| 参数 | 是否必填 | 说明 |
|---|---|---|
| `url` | 是 | 完整 Google Flights URL |
| `--limit` | 否 | 返回行数，默认 `10`，上限 `50` |

接受的 URL 形式：

- `https://www.google.com/travel/flights?...tfs=...`
- `https://www.google.com/travel/flights/search?...tfs=...`

URL 必须同时满足：

- 必须是 absolute URL
- host 必须是 Google
- path 必须是 Google Flights 路径
- 如果使用 `/travel/flights`，query 中必须包含 `tfs`

### 示例

```bash
opencli google-flights results 'https://www.google.com/travel/flights/search?tfs=CBwQAhopEgoyMDI2LTA0LTIyag0IAxIJL20vMGdwNWw2cgwIAxIIL20vMGRxeXdAAUgBcAGCAQsI____________AZgBAg&tfu=EgYIABAAGAA&hl=en' --limit 1
```

当前输出形状：

```text
Rank  Price  Airline  Flight_number  Stops    Depart             Arrive             Duration     From_airport                    To_airport
1     5,830  Jetstar  GK 156         nonstop  2026-04-22 16:40   2026-04-22 19:00   2 hr 20 min New Chitose Airport (CTS)     Kansai International Airport (KIX)
```

`results` 只返回 parsed row objects，不提供自己的 `--api` 参数。

## OpenCLI 全局格式化

除了 adapter 自带参数外，OpenCLI 本身还支持全局输出格式，例如：

```bash
opencli google-flights results '<google-flights-url>' -f json
opencli google-flights search --from Tokyo --to Sapporo --depart 2026-04-22 -f table
```

如果你要更丰富、由 adapter 自定义的 JSON payload，请使用 `--api`。如果你只是想把普通结果行转成 `json`、`yaml`、`csv` 或 `table`，请使用 OpenCLI 全局 `-f/--format`。

## 当前限制

以下是当前实现状态，不是未来理想行为：

- `search` 依赖实时 Google Flights UI 自动化，所以如果 Google 改版，流程可能失效
- `3+` 段 multi-city `--combined` 当前通过 replay Google shopping steps 推导 bundle total；这比简单把各段 one-way 相加准确得多，但仍属于 bounded search，不会枚举所有可能分支
- `booking_provider` 和 `booking_url` 在 DOM-walked flows 中最可靠；API-first 的 `3+` 段 combined 可能为空
- 当前 live 测试中，`query.*` 能较稳定地保留原始查询；但 `search_url` 和 `flights[*]` 仍可能反映 Google 最终实际解析出的结果，因此返回行不一定与原始要求的日期或 route label 完全一致
- `results` 最适合用在你已经有可信 Google Flights 结果 URL，只需要稳定解析该页面时

## 建议使用方式

- 需要实时、浏览器驱动的查询时，使用 `search`
- 需要程序化接收结构化结果时，使用 `search --api`
- 想让 Google Flights 自己扩展城市级范围时，使用城市名
- 想把搜索锁定在特定机场，例如 `TPE`、`SIN`、`NRT` 时，使用 IATA 机场代码
- 想逐段查看每个 leg 的候选票时，使用默认 multi-city 模式
- 想拿 Google 的 bundled multi-city 价格时，使用 `--combined`
- 已经信任某个结果 URL，只需要做页面解析时，使用 `results`
