# Google Flights for OpenCLI

## English

### GitHub Description

`Google Flights adapter for OpenCLI with one-way, round-trip, and multi-city search, native combined pricing, result URL parsing, and JSON API output.`

### README Intro

This adapter brings Google Flights into OpenCLI.

It supports one-way, round-trip, and multi-city search, including Google Flights native combined pricing for stitched itineraries. It can also parse an existing Google Flights result URL and return either normal row output or adapter-defined JSON payloads through `--api`.

Current capabilities:

- Search by city name or IATA airport code
- One-way, round-trip, and multi-city itineraries
- Multi-city separate pricing and Google native combined pricing
- Structured JSON output for programmatic use
- Result-page parsing from an existing Google Flights URL

### Install Into OpenCLI

This repository is an OpenCLI adapter directory, not a Codex skill. OpenCLI discovers it from:

```text
~/.opencli/clis/google-flights
```

Fresh install:

```bash
mkdir -p ~/.opencli/clis
git clone https://github.com/s884812/opencli-google-flights.git ~/.opencli/clis/google-flights
opencli list | grep google-flights
```

If you already cloned the repository elsewhere, symlink it into OpenCLI's adapter directory:

```bash
mkdir -p ~/.opencli/clis
ln -s /path/to/opencli-google-flights ~/.opencli/clis/google-flights
```

Update an existing install:

```bash
git -C ~/.opencli/clis/google-flights pull
```

After installation, OpenCLI should expose:

```bash
opencli google-flights search ...
opencli google-flights results <url> ...
```

Quick examples:

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07
opencli google-flights search --segments 'HKG>TPE@2026-10-28;TPE>NRT@2026-11-24;NRT>TPE@2027-01-07;TPE>HKG@2027-02-10' --combined --api
opencli google-flights results '<google-flights-url>' --limit 5
```

Documentation:

- English usage: [USAGE.md](./USAGE.md)
- Traditional Chinese usage: [USAGE.zh-TW.md](./USAGE.zh-TW.md)
- Simplified Chinese usage: [USAGE.zh-CN.md](./USAGE.zh-CN.md)

## 繁體中文

### GitHub Description

`OpenCLI 的 Google Flights adapter，支援單程、來回、多段票、Google 原生合併計價、結果網址解析，以及 JSON API 輸出。`

### README 開頭介紹

這個 adapter 把 Google Flights 帶進 OpenCLI。

它支援單程、來回與多段行程搜尋，也支援 Google Flights 原生的 multi-city 合併計價流程，用來取得 stitched itinerary 的 bundle 結果。另外，它也可以直接解析既有的 Google Flights 結果網址，並透過一般列輸出或 `--api` 回傳結構化 JSON。

目前功能包括：

- 以城市名或 IATA 機場代碼搜尋
- 單程、來回、多段行程
- 多段分段計價與 Google 原生合併計價
- 適合程式接取的 JSON 結構化輸出
- 直接解析既有 Google Flights 結果頁網址

### 安裝到 OpenCLI

這個 repo 是 OpenCLI adapter 目錄，不是 Codex skill。OpenCLI 會從下列位置掃描到它：

```text
~/.opencli/clis/google-flights
```

全新安裝：

```bash
mkdir -p ~/.opencli/clis
git clone https://github.com/s884812/opencli-google-flights.git ~/.opencli/clis/google-flights
opencli list | grep google-flights
```

如果你已經把 repo clone 到其他位置，可以用 symlink 接到 OpenCLI 的 adapter 目錄：

```bash
mkdir -p ~/.opencli/clis
ln -s /path/to/opencli-google-flights ~/.opencli/clis/google-flights
```

更新既有安裝：

```bash
git -C ~/.opencli/clis/google-flights pull
```

安裝後，OpenCLI 應該會提供：

```bash
opencli google-flights search ...
opencli google-flights results <url> ...
```

快速範例：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07
opencli google-flights search --segments 'HKG>TPE@2026-10-28;TPE>NRT@2026-11-24;NRT>TPE@2027-01-07;TPE>HKG@2027-02-10' --combined --api
opencli google-flights results '<google-flights-url>' --limit 5
```

文件：

- 英文說明：[USAGE.md](./USAGE.md)
- 繁體中文說明：[USAGE.zh-TW.md](./USAGE.zh-TW.md)
- 簡體中文說明：[USAGE.zh-CN.md](./USAGE.zh-CN.md)

## 简体中文

### GitHub Description

`OpenCLI 的 Google Flights adapter，支持单程、往返、多段票、Google 原生合并计价、结果网址解析，以及 JSON API 输出。`

### README 开头介绍

这个 adapter 把 Google Flights 带进 OpenCLI。

它支持单程、往返和多段行程搜索，也支持 Google Flights 原生的 multi-city 合并计价流程，用来获取 stitched itinerary 的 bundle 结果。此外，它也可以直接解析现有的 Google Flights 结果 URL，并通过普通行输出或 `--api` 返回结构化 JSON。

当前功能包括：

- 使用城市名或 IATA 机场代码搜索
- 单程、往返、多段行程
- 多段分段计价与 Google 原生合并计价
- 适合程序接入的 JSON 结构化输出
- 直接解析现有 Google Flights 结果页 URL

### 安装到 OpenCLI

这个 repo 是 OpenCLI adapter 目录，不是 Codex skill。OpenCLI 会从下面的位置扫描到它：

```text
~/.opencli/clis/google-flights
```

全新安装：

```bash
mkdir -p ~/.opencli/clis
git clone https://github.com/s884812/opencli-google-flights.git ~/.opencli/clis/google-flights
opencli list | grep google-flights
```

如果你已经把 repo clone 到其他位置，可以用 symlink 接到 OpenCLI 的 adapter 目录：

```bash
mkdir -p ~/.opencli/clis
ln -s /path/to/opencli-google-flights ~/.opencli/clis/google-flights
```

更新已有安装：

```bash
git -C ~/.opencli/clis/google-flights pull
```

安装后，OpenCLI 应该会提供：

```bash
opencli google-flights search ...
opencli google-flights results <url> ...
```

快速示例：

```bash
opencli google-flights search --from TPE --to SIN --depart 2026-11-24
opencli google-flights search --from TPE --to SIN --depart 2026-11-24 --return 2027-01-07
opencli google-flights search --segments 'HKG>TPE@2026-10-28;TPE>NRT@2026-11-24;NRT>TPE@2027-01-07;TPE>HKG@2027-02-10' --combined --api
opencli google-flights results '<google-flights-url>' --limit 5
```

文档：

- 英文说明：[USAGE.md](./USAGE.md)
- 繁体中文说明：[USAGE.zh-TW.md](./USAGE.zh-TW.md)
- 简体中文说明：[USAGE.zh-CN.md](./USAGE.zh-CN.md)
