# Upstox Charting App: Consolidated Engineering Brief

Consolidated from five research briefs plus live verification of `complete.json.gz` on
2026-08-19 (HTTP GET + in-memory parse, nothing written to disk). Every factual claim
cites its source.

Citation keys:

- `docs/NN-name.md` = `D:/AI Bootcamp 2026/Day13/broker-api-docs/upstox-api-docs/NN-name.md`
- `oa/...` = `D:/AI Bootcamp 2026/Day13/openalgo/broker/upstox/...`
- `app/...` = `D:/AI Bootcamp 2026/Day13/upstox app/backend/app/...`
- `LIVE 2026-08-19` = measured by me against the real asset today. Treat as the
  authority where docs or briefs disagree, but note it is one day of evidence.

---

## 0. The five things most likely to break you

1. `instrument_key` is **not constructible**. Its right-hand side is an ISIN
   (`NSE_EQ|INE002A01018`), a numeric token (`NSE_FO|48699`), or a free-text name with
   spaces and mixed case (`NSE_INDEX|Nifty Bank`, `NSE_INDEX|NIFTY MID SELECT`).
   `LIVE 2026-08-19`. Store it verbatim, never rebuild it.
2. `complete.json.gz` needs **no access token**. `LIVE 2026-08-19`: bare GET, no
   `Authorization` header, HTTP 200. Corroborated by `oa/database/master_contract_db.py`
   using a plain `requests.get(url, timeout=10)`. The master refresh does not have to
   wait for OAuth.
3. The file is served as `Content-Type: application/gzip`, **not**
   `Content-Encoding: gzip` (`LIVE 2026-08-19`). httpx will not auto-decompress it. You
   must call `gzip.decompress()` yourself. `app/upstox.py:143` already does this
   correctly.
4. `instruments.symbol TEXT PRIMARY KEY` (`app/db.py:35`) cannot hold the master. See
   bug 5.
5. Upstox error responses carry `error_code`, not `errorCode`
   (`docs/03a-response-structure.md:38,51,58`, which marks the camelCase variant
   deprecated). `app/upstox.py:42` reads the deprecated name, so every
   `UpstoxError.code` in the app is `""` today. See bug 1.

---

## 1. Instrument master

### 1.1 Download URL

```
https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz
```

`docs/07b-instrument-files.md:11`. Use this one file for every exchange.

| File | `docs/07b:9-23` | `LIVE 2026-08-19` rows / gz bytes |
|---|---|---|
| `complete.json.gz` | Complete BOD | **124,738 / 3,449,636** |
| `NSE.json.gz` | NSE BOD | 82,409 / 2,044,646 |
| `BSE.json.gz` | BSE BOD | 26,385 / 754,047 |
| `MCX.json.gz` | MCX BOD | 15,931 / 281,695 |
| `suspended-instrument.json.gz` | Suspended | 33,718 / 845,562 |
| `MTF.json.gz` | MTF-eligible | 1,348 / 60,242 |
| `NSE_MIS.json.gz` | MIS NSE | 1,348 / 55,239 |
| `BSE_MIS.json.gz` | MIS BSE | 1,328 / 49,830 |

82,409 + 26,385 + 15,931 = 124,725. The remaining 13 rows are `GLOBAL_INDEX` (10) and
`GLOBAL_INDICATOR` (3), which exist **only** in `complete.json.gz` (`LIVE 2026-08-19`).
`app/config.py:27-29` currently points at `NSE.json.gz`, so today the app cannot see
BSE, MCX, or any global feed at all. CSV variants are deprecated
(`docs/07b-instrument-files.md:5`).

Uncompressed JSON is 58,437,941 bytes (55.7 MB), `LIVE 2026-08-19`.

### 1.2 Exact field list

`docs/07b-instrument-files.md:27-37` lists 13 / 16 / 17 / 7 fields for EQ / FUT / OPT /
INDEX. **The doc list is incomplete.** The live file carries **34 distinct keys**
(`LIVE 2026-08-19`; brief 1 said 35, which is wrong for `complete.json.gz` -
`intraday_margin` and `intraday_leverage` only appear in the `*_MIS` files).

Presence measured over all 124,738 rows:

| Field | Present | Type | Notes |
|---|---|---|---|
| `segment` | 100% | str | 12 values, section 1.3 |
| `name` | 100% | str | company / underlying name, NOT the ticker |
| `exchange` | 100% | str | only `NSE` 82409, `BSE` 26385, `MCX` 15931, `GLOBAL` 13. Coarser than `segment`; do not key on it |
| `instrument_type` | 100% | str | 147 distinct values; `""` on the 13 GLOBAL rows |
| `instrument_key` | 100% | str | `"<segment>\|<id>"`. **124,738 distinct over 124,738 rows, zero duplicates** |
| `exchange_token` | 100% | str | **string, not int**; `""` on all 13 GLOBAL rows |
| `trading_symbol` | 100% | str | the ticker |
| `lot_size` | 99.83% | int | absent on NSE_INDEX (139) + BSE_INDEX (77) |
| `freeze_quantity` | 99.83% | float | same 216 missing |
| `tick_size` | 99.83% | float | same 216 missing. **Unit is PAISE**, see 1.5 |
| `qty_multiplier` | 96.37% | float | absent on all BSE_FO + the 216 indices |
| `strike_price` | 81.91% | float | `0.0` on futures, not absent |
| `asset_symbol` / `underlying_symbol` | 81.89% | str | identical pair in every row inspected |
| `asset_type` / `underlying_type` | 81.89% | str | COM 43421, EQUITY 30256, CUR 16228, INDEX 10305, IRD 1920, `""` 13 |
| `expiry` | 81.88% | **int, epoch ms** | on 100% of `*_FO` and `NSE_COM`; zero FO rows lack it |
| `asset_key` / `underlying_key` | 67.34% | str | **absent on NCD_FO and BCD_FO entirely** |
| `weekly` | 46.54% | bool | F&O only |
| `minimum_lot` | 46.54% | int | F&O only; absent on MCX_FO and NSE_COM |
| `price_quote_unit` | 35.38% | str | commodity only, e.g. `"KGS"` |
| `last_trading_date` | 35.35% | int, epoch ms | commodity only |
| `isin` | 17.93% | str | equities; `""` on GLOBAL rows |
| `security_type` | 7.74% | str | **NSE_EQ only** (9,655 rows = 100% of NSE_EQ). NORMAL 9072, SME 553, PCA 27, IPO 3. Never on BSE_EQ |
| `short_name` | 2.88% | str | sparse display name |
| `mtf_enabled` / `mtf_bracket` | 1.09% | bool / float | |
| `cas_eligible` | 0.34% | bool | |
| `country`, `latency`, `start_time`, `end_time`, `week_days` | 13 rows | str | GLOBAL_* only |

**Only seven fields are safe as NOT NULL**: `segment`, `name`, `exchange`,
`instrument_type`, `instrument_key`, `exchange_token`, `trading_symbol`. Everything else
needs `.get()`.

Verbatim live rows (`LIVE 2026-08-19`, trimmed):

```
NSE_EQ    {"segment":"NSE_EQ","name":"RELIANCE INDUSTRIES LTD","exchange":"NSE",
           "isin":"INE002A01018","instrument_type":"EQ",
           "instrument_key":"NSE_EQ|INE002A01018","lot_size":1,
           "freeze_quantity":100000.0,"exchange_token":"2885","tick_size":10.0,
           "trading_symbol":"RELIANCE","short_name":"Reliance Industries",
           "qty_multiplier":1.0,"mtf_enabled":true,"mtf_bracket":23.0,
           "security_type":"NORMAL","cas_eligible":true}

NSE_INDEX {"segment":"NSE_INDEX","name":"Nifty Bank","exchange":"NSE",
           "instrument_type":"INDEX","instrument_key":"NSE_INDEX|Nifty Bank",
           "exchange_token":"26009","trading_symbol":"BANKNIFTY"}

NSE_FO    {"weekly":false,"segment":"NSE_FO","name":"BANKNIFTY","exchange":"NSE",
           "expiry":1793125799000,"instrument_type":"FUT","asset_symbol":"BANKNIFTY",
           "underlying_symbol":"BANKNIFTY","instrument_key":"NSE_FO|48699","lot_size":30,
           "freeze_quantity":600.0,"exchange_token":"48699","minimum_lot":30,
           "asset_key":"NSE_INDEX|Nifty Bank","underlying_key":"NSE_INDEX|Nifty Bank",
           "tick_size":20.0,"asset_type":"INDEX","underlying_type":"INDEX",
           "trading_symbol":"BANKNIFTY FUT 27 OCT 26","strike_price":0.0,
           "qty_multiplier":1.0}

NSE_FO    {"...","instrument_type":"CE","instrument_key":"NSE_FO|50918",
           "asset_key":"NSE_INDEX|NIFTY MID SELECT",
           "trading_symbol":"MIDCPNIFTY 15250 CE 27 OCT 26","strike_price":15250.0}
```

Note the two index keys in that sample: `NSE_INDEX|Nifty Bank` (title case) and
`NSE_INDEX|NIFTY MID SELECT` (upper case). **Upstox is internally inconsistent about
index key casing.** This is the single hardest proof that keys must be copied verbatim.

### 1.3 Exact segment list

12 distinct values, exhaustive (`LIVE 2026-08-19`):

| `segment` | Rows | Meaning | `oa/database/master_contract_db.py:133-149` maps to |
|---|---|---|---|
| `NSE_FO` | 35,584 | NSE equity + index F&O | `NFO` |
| `NSE_COM` | 28,187 | NSE commodity derivatives | **dropped** (`master_contract_db.py:126`) |
| `MCX_FO` | 15,931 | MCX commodity F&O | `MCX` |
| `BSE_EQ` | 12,696 | BSE cash | `BSE` |
| `NSE_EQ` | 9,655 | NSE cash: equities, ETFs, SGBs, T-bills, NCDs | `NSE` |
| `BCD_FO` | 9,304 | BSE currency + interest-rate derivatives | `BCD` |
| `NCD_FO` | 8,844 | NSE currency derivatives | `CDS` |
| `BSE_FO` | 4,308 | BSE F&O (SENSEX, BANKEX) | `BFO` |
| `NSE_INDEX` | 139 | NSE indices | passthrough |
| `BSE_INDEX` | 77 | BSE indices | passthrough |
| `GLOBAL_INDEX` | 10 | world indices, quote-only | passthrough |
| `GLOBAL_INDICATOR` | 3 | USDINR ref rate, Brent, WTI | folded into `GLOBAL_INDEX` |

`MCX_COM` appears as an `asset_key`/`underlying_key` prefix (e.g. `"MCX_COM|115"`) but
**never as a row's own segment**. Do not put a foreign key on `underlying_key`.

**Do not port OpenAlgo's `NSE_COM` drop.** `master_contract_db.py:126` carries no
comment; brief 4 confirms no stated reason. It is an OpenAlgo namespace-collision
decision (its `exchange_map` already spends `MCX` on `MCX_FO`), not an Upstox
limitation: `docs/25-api-endpoints-reference.md` lists `NSCOM` as a supported exchange.
A charting app has no such collision because it keys on `instrument_key`.

**Do not port OpenAlgo's `.map()` pattern either.** `master_contract_db.py:143-145`
comments that unmapped segments "would silently land with exchange=NULL". Any segment
Upstox adds later disappears silently. Use an explicit whitelist that logs unknowns.

### 1.4 Recommended SQLite schema (raw SQL, no ORM)

```sql
-- Full Upstox BOD instrument master, rebuilt wholesale from complete.json.gz.
-- Primary key is instrument_key because it is the only globally unique column:
-- 124,738 distinct over 124,738 rows (verified live 2026-08-19). trading_symbol is
-- NOT unique even within a segment (5 live collisions on NSE_EQ), and exchange_token
-- is blank on all 13 GLOBAL rows.
CREATE TABLE IF NOT EXISTS instruments (
    instrument_key    TEXT    NOT NULL PRIMARY KEY,
    segment           TEXT    NOT NULL,
    exchange          TEXT    NOT NULL,
    trading_symbol    TEXT    NOT NULL,
    name              TEXT    NOT NULL,
    instrument_type   TEXT    NOT NULL,
    exchange_token    TEXT    NOT NULL,
    -- Everything below is optional in the source file: use .get(), never [].
    isin              TEXT,
    short_name        TEXT,
    security_type     TEXT,
    lot_size          INTEGER,
    -- tick_size is stored exactly as published, which is PAISE. Divide by 100 for
    -- rupees at the point of display. OpenAlgo stores it raw and never divides,
    -- which is a latent bug we are choosing not to inherit silently.
    tick_size_paise   REAL,
    freeze_quantity   REAL,
    strike_price      REAL,
    -- expiry in the file is epoch MILLISECONDS, undocumented. expiry_date is the IST
    -- calendar date derived once at ingest so query-time code never re-guesses units.
    expiry_ms         INTEGER,
    expiry_date       TEXT,
    underlying_key    TEXT,
    underlying_symbol TEXT,
    underlying_type   TEXT,
    weekly            INTEGER,
    -- Derived at ingest for the typeahead: trading_symbol uppercased with spaces
    -- removed, so "INDIA VIX" is reachable by typing "INDIAVIX".
    search_symbol     TEXT    NOT NULL,
    -- 1 if the key appears in suspended-instrument.json.gz. Kept rather than deleted
    -- so a stale bookmark resolves to an explanation instead of a 404.
    suspended         INTEGER NOT NULL DEFAULT 0
);

-- One row. Drives conditional GET so a no-op refresh costs a few hundred bytes
-- instead of 3.4 MB.
CREATE TABLE IF NOT EXISTS instrument_sync (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    source_url    TEXT    NOT NULL,
    etag          TEXT,
    last_modified TEXT,
    row_count     INTEGER NOT NULL DEFAULT 0,
    suspended_ct  INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL,
    synced_at     TEXT    NOT NULL
);

-- Indexes are created AFTER the bulk insert, never before: building them during a
-- 124k-row load roughly doubles the insert time.
CREATE INDEX IF NOT EXISTS idx_instruments_symbol
    ON instruments (trading_symbol, segment);
CREATE INDEX IF NOT EXISTS idx_instruments_search
    ON instruments (search_symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_segment
    ON instruments (segment, instrument_type);
CREATE INDEX IF NOT EXISTS idx_instruments_underlying
    ON instruments (underlying_key, expiry_date);
```

Notes on the choices:

- No `UNIQUE` on `trading_symbol` or `(segment, trading_symbol)`. `LIVE 2026-08-19`
  found exactly 5 live collisions, all NSE_EQ: `CHOLAFIN` (EQ `NSE_EQ|INE121A01024` vs
  D1 debenture `NSE_EQ|INE121A08PJ0`), `ELECTCAST`, `MOTHERSON`, `IMC1` (three N-series
  tranches). A unique constraint drops rows or raises.
- Prefix search `search_symbol LIKE 'ABC%'` uses `idx_instruments_search`. Infix
  `LIKE '%abc%'` cannot use any index and full-scans 124k rows. If infix matching is
  required, add an FTS5 virtual table over `trading_symbol || ' ' || name`; keep the
  base table rowid-backed (do **not** use `WITHOUT ROWID`) so FTS5 external-content
  stays available.
- Expected on-disk cost: roughly 15-25 MB added to `backend/upstox.db`. Worth noting
  next to the `candles` table (`app/db.py:41-53`), which still has no eviction policy.

### 1.5 Units and gotchas the docs never state

All `LIVE 2026-08-19` unless noted.

- **`expiry` is epoch milliseconds, integer.** `docs/07b-instrument-files.md:31` names
  the field and gives no type. `oa/database/master_contract_db.py:151` confirms ms with
  `pd.to_datetime(df["expiry"], unit="ms")`. Decoded in IST, every expiry lands at
  23:59:59 IST of the expiry date: `1793125799000` = `2026-10-27T23:59:59+05:30`,
  matching `trading_symbol` "BANKNIFTY FUT 27 OCT 26". Correct conversion is
  `datetime.fromtimestamp(ms/1000, IST).date()`. OpenAlgo's naive-UTC `pd.to_datetime`
  gives the right calendar date only because 23:59:59 IST is 18:29:59 UTC the same day.
  Do not copy that pattern.
- **The file and the REST API disagree on expiry representation.** Files use epoch ms;
  `docs/20a-option-contracts.md:19`, `docs/08b`, `docs/08c` all use `YYYY-MM-DD` strings.
  Brief 1 and brief 4 both flag this; they agree.
- **`tick_size` is in PAISE.** Undocumented. Distinct values by segment
  (`LIVE 2026-08-19`): NSE_EQ {1,5,10,50,100,500}, BSE_EQ {1,5}, NSE_FO
  {1,5,10,20,50,100,500}, BSE_FO {5,100}, NCD_FO {0.25}, BCD_FO {0.25}, MCX_FO
  {1,5,10,50,100,1000}, NSE_COM {1,5,10,50,100}, GLOBAL_* {0}. RELIANCE reads `10.0`
  and its real tick is Rs 0.10; USDINR reads `0.25` and its real tick is Rs 0.0025;
  MCX SILVER reads `100.0` and its real tick is Rs 1. Divide by 100.
- **`exchange_token` is a string and is empty on all 13 GLOBAL rows**, so
  `(segment, exchange_token)` is not unique either.
- **`name` vs `trading_symbol`**: for equities `name` is the company
  ("RELIANCE INDUSTRIES LTD") and `trading_symbol` is the ticker ("RELIANCE"). For F&O
  `name` is the underlying root ("BANKNIFTY") and `trading_symbol` is the spaced
  contract string ("BANKNIFTY FUT 27 OCT 26").

### 1.6 Suspended rows: brief 1 is wrong, correction here

Brief 1 claims subtracting `suspended-instrument.json.gz` removes "~26.7k dead NSE
tickers" from your search. **That is wrong.** `LIVE 2026-08-19`: the suspended file has
33,718 rows (NSE_EQ 26,695, BSE_EQ 7,023), but only **5,921** of those instrument_keys
also appear in `complete.json.gz`. Upstox already excludes most of them from the BOD
file (`docs/07b-instrument-files.md:41`: "BOD instruments exclude delisted stocks and
expired contracts").

So the suspended cross-reference is still worth doing (5,921 rows is 6% of NSE_EQ +
BSE_EQ combined and they are all unchartable), but it is a `suspended` flag on a small
minority, not a bulk filter. The sentinel `lot_size: 999999999` /
`freeze_quantity: 999999999.0` in the suspended file is a reliable marker
(`LIVE 2026-08-19`).

### 1.7 Do not filter by `instrument_type`

`app/upstox.py:146` keeps only `segment == "NSE_EQ" and instrument_type == "EQ"`. Two
failures: every index is dropped (so NIFTY and BANKNIFTY can never be charted), and BSE
equities carry group codes rather than `EQ` (`docs/07a-instrument-search.md` lists valid
`instrument_types` as "`CE`, `PE`, `A`, `X`, etc."), so the same filter would drop all
of BSE. `oa/database/master_contract_db.py` filters nothing except `NSE_COM`.
**Filter by `segment` only, and store everything.**

Practical chartable filters to apply at *query* time, not ingest time (all inferred, no
doc enumerates the 147 `instrument_type` codes, **unverified**):

- NSE equity: `segment='NSE_EQ' AND instrument_type IN ('EQ','BE') AND security_type='NORMAL'`
- BSE equity: `segment='BSE_EQ' AND instrument_type IN ('A','B')` for the liquid groups
- Indices: `segment IN ('NSE_INDEX','BSE_INDEX')`
- `GLOBAL_INDICATOR` is **not chartable**, see section 4.4.

### 1.8 Insert strategy for 124,738 rows

Measured by brief 1 on this machine (Python 3.14.4), consistent with my live run:

| Approach | Time | tracemalloc peak |
|---|---|---|
| `json.loads` whole file, hold list of dicts | 1.67 s | **210 MB** (plus the 56 MB source bytes still live) |
| `json.JSONDecoder().raw_decode()` loop, project straight to tuples | 1.88 s | **89 MB** (mostly the 56 MB `str` itself) |

Recommended sequence:

1. Conditional GET with the stored `If-None-Match`. A 304 ends the job (see 1.9).
2. `gzip.decompress(response.content)` then `.decode()`. Do **not** build a 124k-element
   list of dicts. Loop `raw_decode` over the decoded string, projecting each object to a
   10-to-20 element tuple, appending only tuples. Free the gz bytes and the decoded
   string as soon as the loop ends.
3. Also fetch and parse `suspended-instrument.json.gz` into a `set` of instrument_keys
   (33,718 strings, cheap) for the `suspended` flag.
4. Open one connection, one explicit transaction. Inside it: `DELETE FROM instruments;`
   then `executemany` in batches of ~5,000 to bound the parameter list. Set
   `PRAGMA synchronous = OFF` for the duration of the load only; `journal_mode = WAL` is
   already set at `app/db.py:72`. **Rebuild, do not merge**: expired F&O contracts vanish
   from the file, so an `INSERT OR REPLACE` that never deletes accumulates dead contracts
   forever. The full rebuild is also your expiry-pruning mechanism.
5. Create the four indexes after the insert, still inside the same transaction or
   immediately after it.
6. Update `instrument_sync` with the new etag, last_modified, row_count, synced_at.

Do **not** copy OpenAlgo's shape at `master_contract_db.py:275-276`, which does
delete-then-insert without a transaction and leaves the table empty if the insert
throws. Sub-2 seconds inside one transaction; tens of seconds if each row autocommits.

### 1.9 Refresh schedule and cache invalidation

`docs/07b-instrument-files.md:41`: "Files refresh daily around 6 AM and selectively
during trading hours."

`LIVE 2026-08-19` confirms both the 6 AM claim and that the "selective" updates hit the
MIS files, not the BOD family:

```
complete.json.gz              Last-Modified: Tue, 18 Aug 2026 23:56:00 GMT (05:26 IST 19 Aug)
NSE.json.gz / BSE.json.gz     Last-Modified: Tue, 18 Aug 2026 23:55:59 GMT
suspended-instrument.json.gz  Last-Modified: Tue, 18 Aug 2026 23:56:01 GMT
NSE_MIS.json.gz               Last-Modified: Wed, 19 Aug 2026 03:01:06 GMT (08:31 IST)
BSE_MIS.json.gz               Last-Modified: Wed, 19 Aug 2026 03:01:06 GMT
```

**Use conditional GET, not a timer.** `LIVE 2026-08-19`, verified this run:

```
If-None-Match: "c457b17d662724102deba96235d2af74"  ->  HTTP 304 Not Modified
```

`If-Modified-Since` is honoured too. Recommended policy, adapted from
`openalgo/utils/auth_utils.py:35-60,80-136`, which re-downloads if never downloaded, if
the last download was on an earlier IST calendar day, or if it happened before the 08:00
IST cutoff today ("The Indian exchanges publish a complete symbol list once daily before
market open; 08:00 IST is a safe cache boundary"):

- Consider the local master stale if `synced_at` predates today's 06:00 IST and now is
  past ~06:15 IST. Then let the ETag decide whether to actually rebuild.
- Trigger from the FastAPI lifespan hook next to `init_db()` **and** from the OAuth
  callback, as a background task. Neither needs a token.
- **Caveat**: responses come via CloudFront (`Via: CloudFront`, `Server: AmazonS3`,
  `Age: 51693` observed by brief 1). A POP can serve a stale object for hours after
  Upstox publishes. An early-morning 304 does not prove you are current; retry later
  rather than treating it as authoritative.

### 1.10 Instrument Search REST API: when to use it instead

`GET https://api.upstox.com/v2/instruments/search` (`docs/07a-instrument-search.md`;
`docs/25-api-endpoints-reference.md`). v2 only, no v3 variant listed.

| Param | Req | Values |
|---|---|---|
| `query` | Yes | free text, **max 50 chars** |
| `exchanges` | No | `ALL` (default), `NSE`, `BSE`, `MCX` |
| `segments` | No | `ALL`, `EQ`, `FO`, `CURR`, `COMM`, `INDEX`, `OPT`, `FUT` |
| `instrument_types` | No | `CE`, `PE`, `A`, `X`, etc., comma-separated |
| `expiry` | No | `current_week`, `current_month`, `next_month`, or `yyyy-MM-dd` |
| `atm_offset` | No | 0 = ATM, positive above, negative below |
| `page_number` | No | 1-based, default 1 |
| `records` | No | default 10, **max 30** |

Errors: `UDAPI1169` empty query, `UDAPI1170` query > 50 chars, `UDAPI1171` invalid
exchange, `UDAPI1172` invalid segment, `UDAPI1173` records > 30, `UDAPI1174` invalid page
number, `UDAPI1175` invalid expiry format.

**Requires an access token.** Brief 1 verified empirically: unauthenticated call returns
HTTP 401 `{"errorCode":"UDAPI100050",...}`.

**Do not use it as the typeahead.** 30 records per page, a network round trip per
keystroke, a token requirement, and a shared 50/sec + 2000/30min budget competing with
your candle fetches. Local SQLite is faster, works before login, and has no quota. Use
the API **only** for `atm_offset` and the `expiry` keywords, which are server-side
computations (ATM needs a live spot price) you cannot reproduce from the static file.

---

## 2. Candle API constraints

### 2.1 Exact V3 URL shapes

Historical (`docs/17a-historical-candle-v3.md:9`;
`docs/25-api-endpoints-reference.md:83`):

```
GET https://api.upstox.com/v3/historical-candle/{instrument_key}/{unit}/{interval}/{to_date}/{from_date}
```

Intraday (`docs/17b-intraday-candle-v3.md:9`;
`docs/25-api-endpoints-reference.md:84`) - note the literal `intraday` segment comes
**before** the instrument key, unlike historical:

```
GET https://api.upstox.com/v3/historical-candle/intraday/{instrument_key}/{unit}/{interval}
```

`from_date` is optional on historical (`docs/17a:29`) but the docs never say what range
is returned when omitted. Do not rely on it. `app/upstox.py:116,126` already
`quote(key, safe="")` correctly, which is what avoids `UDAPI1021`.

V2 is a different shape entirely (single compound interval string, no unit segment):
`docs/17c-historical-candle-v2.md:5,22` and `docs/17d-intraday-candle-v2.md:5,12`.
Expired-instrument candles are V2-only, `from_date` required, and need Upstox Plus
(`docs/08d-expired-historical-candle.md:5,12,29`).

### 2.2 Unit / interval matrix (V3)

| unit | interval allowed | historical endpoint | intraday endpoint |
|---|---|---|---|
| `minutes` | 1-300 | yes | yes |
| `hours` | 1-5 | yes | yes |
| `days` | 1 only | yes | yes |
| `weeks` | 1 only | yes | **no** |
| `months` | 1 only | yes | **no** |

`docs/17a-historical-candle-v3.md:13-19,27`; `docs/17b-intraday-candle-v3.md:16-17`.

**Is every integer 1..300 really legal?** The docs state it as a contiguous range and
nowhere enumerate a whitelist. Whether Upstox rejects non-divisors such as 7 or 23 is
**not stated either way and is unverified.** Treat "all integers in range" as the
documented contract and let `UDAPI1147` be the runtime authority
(`docs/17a:61`, `docs/17b:30`). OpenAlgo hedges by exposing only a curated subset
(`oa/api/data.py:53-72`): minutes 1, 2, 3, 5, 10, 15, 30, 60; hours 1-4; days/weeks/
months 1. It ships no 5-hour bar even though hours=5 is legal.

Error codes: `UDAPI1146` invalid unit, `UDAPI1147` invalid interval for unit.

### 2.3 Max window per request, per unit

| unit | interval | Max range per request (`docs/17a:13-19`) | OpenAlgo's day count (`oa/api/data.py:569-590`) |
|---|---|---|---|
| `minutes` | 1-15 | 1 month | 30 |
| `minutes` | 16-300 | 1 quarter | 90 |
| `hours` | 1-5 | 1 quarter | 90 |
| `days` | 1 | 1 decade | 3650 |
| `weeks` | 1 | Unlimited | 7300 |
| `months` | 1 | Unlimited | 7300 |

**Caveat**: `docs/17a` heads that column "Max Records" while the cell values are
durations, and never defines whether the cap is on the `from_date`..`to_date` span or on
the returned row count. OpenAlgo reads it as a date-span cap. **I trust OpenAlgo's
reading**, because it is production code running against the live API and the doc's own
cells are durations, but note the doc is genuinely ambiguous and neither reading is
verified. "Quarter" is likewise undefined: 90 days versus three calendar months is
potentially off by one at the boundary. **Unverified.**

Chunk walk (`oa/api/data.py:613,643`), inclusive non-overlapping windows:

```
current_end   = min(current_start + timedelta(days=chunk_days - 1), to_date)
current_start = current_end + timedelta(days=1)
```

Unknown `(unit, interval)` pairs fall back to 30 days (`oa/api/data.py:592-598`).
Exceeding the cap yields `UDAPI1148` "Invalid date range" (`docs/17a:62`). Also
`UDAPI1015` if `to_date < from_date`, `UDAPI1022` if `to_date` missing.

### 2.4 How far back history goes

| unit | Earliest data (`docs/17a:13-19`) |
|---|---|
| `minutes` any interval | **January 2022** |
| `hours` | **January 2022** |
| `days` | **January 2000** |
| `weeks` | **January 2000** |
| `months` | **January 2000** |

Asking for 1-minute data from 2019 returns nothing useful; the docs do not say whether
that is an empty array or an error. **Unverified.** V2 depth is much shallower
(`docs/17c:9-15`: `day` only one year), which is another reason to stay on V3.

### 2.5 Response shape

`docs/17a:33-50`. Seven fixed elements:

| Index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| Field | timestamp | open | high | low | close | volume | open interest |

Confirmed verbatim in `docs/17b:21`, `docs/17c:28`, `docs/17d:16`, `docs/08d:18` -
**all five candle endpoints share the row layout**, so parsing code can be shared.

Timestamp is ISO 8601 with explicit IST offset, `YYYY-MM-DDTHH:MM:SS+05:30`
(`docs/17a:39`). `oa/api/data.py:893` shows real responses as
`'2024-12-09T15:29:00+05:30'`, implying minute candles are stamped at bar **open** and
the last NSE 1-minute bar is 15:29 not 15:30. The docs never state the stamping
convention. **Unverified; inferred from one OpenAlgo sample.**

**Ordering within `candles` is not documented.** Do not assume ascending. OpenAlgo sorts
explicitly after concatenating chunks (`oa/api/data.py:660`) and finds the latest bar
with `max(all_candles, key=lambda x: x[0])` rather than `[-1]` (`:811`).
`app/routers/market.py:35-42` already sorts, so the app is safe on this point.

No documented max row count per response and no pagination cursor; the date-range caps
are the only limit.

**An empty `candles` array is a documented-normal outcome, not an error.** Neither
`docs/17a` nor `docs/17b` defines a "no data for range" error code. A weekend, a holiday
or a pre-09:15 window returns `status: "success"` with `data.candles: []`.
`oa/api/data.py` `_fetch_chunk_data` relies on exactly this and logs "No data received"
before continuing. See bug 9.

### 2.6 Intraday vs historical: when does today's data appear where

**The docs are silent.** `docs/17b:5` says intraday "Retrieves OHLC values for the
current trading day"; `docs/17a:5,28` says historical is inclusive of `to_date`. Nothing
in `17a`, `17b`, `17-historical-data.md` or `25-api-endpoints-reference.md` states
whether the current day appears on the historical endpoint, when today migrates, or how
the two overlap.

OpenAlgo's empirically-derived behaviour (`oa/api/data.py:697-870`), which briefs 2 and
4 agree on:

1. If `unit` is `minutes` or `hours` **and** the chunk's `end_date` is today, hit the
   intraday endpoint first (`:709-712`), then filter its candles to the chunk range
   (`:728-731`). Operative assumption: **today's intraday bars are not reliably on the
   historical endpoint.**
2. Then hit historical if no intraday candles came back **or** the chunk starts before
   today (`:741`). A chunk spanning past days plus today calls both.
3. Dedupe by timestamp after the fact, not at fetch time
   (`:655-662` `drop_duplicates(subset=["timestamp"]).sort_values("timestamp")`).
4. `unit=days` for today is a special case with no endpoint at all (`:770-863`):
   OpenAlgo scans for a bar dated today and, if absent, **synthesises** one from
   `/v3/market-quote/ohlc`, stamped at IST midnight, guarded by a stale check that skips
   the synthetic bar if OHLCV exactly matches the most recent real candle
   (`:807-844`, comment "Quotes data appears stale (identical to last candle)").

**Recommendation for this app: do not port step 4.** It is the fiddliest code in the
file and the one most likely to put a phantom bar on a chart. Ports 1-3 only.

Actionable rule: request historical for everything up to and including today;
additionally request intraday **only when** the unit is minutes/hours/days and the
window touches today; merge; dedupe on normalised timestamp keeping the later-fetched
(intraday) copy for the in-progress bar. `app/routers/market.py:204` passes
`_merge(historical, intraday)` and `_merge` lets later groups win, so intraday already
wins correctly today.

### 2.7 Where the current window logic is wrong

Current behaviour, `app/routers/market.py:180`:

```python
from_date = (today - timedelta(days=max(sessions * 3, 12))).isoformat()
```

with `sessions: int = Query(DEFAULT_SESSIONS, ge=1, le=30)` at `:167` and
`DEFAULT_SESSIONS = 5` (`app/config.py:50`). So the window is 15 days by default and 12
to 90 days across the allowed range. It then trims with `_trim_to_sessions`
(`:45-48`), which groups by `iso[:10]`, the calendar date.

Six distinct breaks:

**(a) Blows the 1-month cap on fine minute intervals.** For `minutes` 1-15 the cap is
1 month (`docs/17a:15`). `sessions * 3` exceeds 30 days once `sessions >= 11`, so
`?unit=minutes&interval=1&sessions=11` requests a 33-day span and should return
`UDAPI1148`. At `sessions=30` it asks for 90 days against a 30-day cap. `:190-194` turns
that into a hard `HTTPException`, so the chart goes blank rather than degrading.

**(b) Sits exactly on the quarter boundary for coarse minutes and hours.** At
`sessions=30` the span is 90 days, precisely OpenAlgo's reading of "1 quarter". If
Upstox measures a quarter as three calendar months this is fine; if it measures
inclusive days it is off by one. **Unverified either way**, see 2.3.

**(c) Silently starves `weeks` and `months`.** At `sessions=5` the window is 15 days:
`weeks` yields 2 or 3 bars, `months` yields 1. Even at `sessions=30` a 90-day window
yields about 13 weekly or 3 monthly bars. Both units are documented Unlimited back to
January 2000 (`docs/17a:18-19`), so the app is voluntarily discarding history it is
entitled to. This is the most visible failure for a charting app.

**(d) `_trim_to_sessions` conflates "trading session" with "candle" for coarse units.**
The grouping key is the calendar date. For `days`, `weeks` and `months` there is exactly
one candle per date, so `sessions=5` means "5 bars": coincidentally right for `days`,
meaningless for `weeks` (5 weeks) and `months` (5 months) where the parameter name lies.
Split the parameter into a bar count for coarse units and a session count for intraday
units, or replace it with an explicit date range.

**(e) The intraday call is fired for `weeks` and `months`.** `:197-202` calls
`upstox.intraday_candles` unconditionally, but intraday accepts only `minutes`, `hours`,
`days` (`docs/17b:16`). For weeks and months that is a guaranteed `UDAPI1146` round trip,
swallowed by a bare `except upstox.UpstoxError: intraday = []`. Harmless to correctness,
wasteful of the binding rate-limit budget, and it hides genuine failures on the units
where intraday does matter.

**(f) `sessions * 3` is a guess where `/v2/market/holidays` is an answer.** Nothing in
the app calls it (`docs/19a-market-holidays.md`). During a dense holiday cluster the
multiplier under-delivers; outside one it over-fetches. `_trim_to_sessions` trims by
dates actually present, so the exposure is purely on the fetch side: too few trading
days come back and the chart just shows fewer sessions than asked, with no explanation.

**What correct looks like**: derive the request span from a per-unit chunk table
matching 2.3, page backwards in chunks until either the requested bar count is satisfied
or the 2.4 availability floor is reached, and only then trim. The SQLite cache already
dedupes on `(instrument_key, unit, interval, ts)` (`app/store.py:149-160`), so
subsequent loads should page only the gap between the newest cached bar and today rather
than refetching the whole window every request, which is what the code does today.

### 2.8 Rate limits

`docs/04-rate-limits.md:25-33`. Candles are Standard APIs (line 27 names historical
candles explicitly). Per-API, per-user.

| Window | Standard APIs | Order placement (not used here) |
|---|---|---|
| Per second | 50 | 10 regular / 50 SEBI-registered |
| Per minute | 500 | 500 |
| Per 30 minutes | **2000** | 2000 |

**The 30-minute bucket is the binding constraint**, not the per-second one:
2000 / 1800 s = **1.11 requests/sec sustained**, or 66.7/min, an order of magnitude below
the 500/min figure. Each `/api/market/candles` call makes **two** upstream requests
(`app/routers/market.py:182,198`), so the sustained ceiling is roughly 33 chart refreshes
per minute across all users and symbols on one Upstox account.

Concrete backfill arithmetic: a full 1-minute backfill from Jan 2022 to today is about
44 months at 1 month per request = ~44 requests per symbol. Backfilling 45 symbols at
1-minute exhausts the 30-minute budget.

Violation surfaces as HTTP `429` / `UDAPI10005` (`docs/03b-error-codes.md:14,24`).
`docs/04-rate-limits.md:37` warns that exceeding "might result in temporary suspension of
access", so backfill needs a real throttle, not just retry-on-429. **The docs say nothing
about `Retry-After` or `X-RateLimit-*` headers, nor whether buckets are fixed or sliding.
Unverified. Pick your own backoff.**

---

## 3. Symbol resolution

### 3.1 The pipeline

```
user text -> normalise -> SQLite ranked query -> row -> instrument_key (verbatim)
          -> urllib.parse.quote(key, safe="") -> URL path segment
```

`app/upstox.py:116,126` already quotes correctly. Skipping the quote yields `UDAPI1021`
(`docs/17a:56`), which is distinct from `UDAPI100011` "invalid instrument key"
(`docs/17a:58`, a genuinely unknown or stale key). Handle them separately: `UDAPI1021` is
a code bug, `UDAPI100011` means re-download the master and re-resolve.

### 3.2 Normalising the user's text

Store `search_symbol = trading_symbol.upper().replace(" ", "")` at ingest, and query
against both `trading_symbol` and `search_symbol`. This one derived column handles
almost every index case without a lookup table, because Upstox has already done most of
the normalisation itself (see 3.3).

### 3.3 Index special cases: briefs 1 and 4 directly contradict each other

Brief 4 (relaying `oa/database/master_contract_db.py:183-248`) says NSE index
`trading_symbol` carries the spaced human name ("NIFTY 50", "NIFTY BANK") and needs a
60-entry replace table. Brief 1 says Upstox already publishes the normalised trade name
and that OpenAlgo's table is stale.

**Brief 1 is right. Verified live 2026-08-19:**

| `name` | `trading_symbol` | `instrument_key` |
|---|---|---|
| `Nifty 50` | **`NIFTY`** | `NSE_INDEX\|Nifty 50` |
| `Nifty Bank` | **`BANKNIFTY`** | `NSE_INDEX\|Nifty Bank` |
| `Nifty Fin Service` | **`FINNIFTY`** | `NSE_INDEX\|Nifty Fin Service` |
| `NIFTY MID SELECT` | **`MIDCPNIFTY`** | `NSE_INDEX\|NIFTY MID SELECT` |
| `Nifty Next 50` | **`NIFTYNXT50`** | `NSE_INDEX\|Nifty Next 50` |
| `Nifty FPI 150` | **`NIFTYFPI`** | `NSE_INDEX\|Nifty FPI 150` |
| `India VIX` | `INDIA VIX` | `NSE_INDEX\|India VIX` |
| `BSE SENSEX` | `SENSEX` | `BSE_INDEX\|SENSEX` |
| `BSE SENSEX 50` | `SENSEX50` | `BSE_INDEX\|SENSEX50` |
| `BSE SENSEX NEXT 50` | `SNXT50` | `BSE_INDEX\|SNXT50` |
| `BSE BANKEX` | `BANKEX` | `BSE_INDEX\|BANKEX` |

**Do not port OpenAlgo's NSE index replace table.** Five of its six "must hardcode"
entries are already no-ops against today's file. Its BSE table is partly stale too:
brief 4 says `SNSX50 -> SENSEX50`, but the live file publishes `SENSEX50` directly and
has no `SNSX50` row at all. Porting a stale table costs you correctness for zero benefit.

**What still needs handling (all `LIVE 2026-08-19`):**

1. **Spaces survive in many index tickers**: `INDIA VIX`, `NIFTY IT`, `NIFTY MIDCAP 100`,
   `NIFTY OIL AND GAS`, `NIFTY500 QLTY50`. The derived `search_symbol` column solves all
   of them at once. This is why 3.2 is a column and not a lookup table.
2. **BSE index codes collide with equity tickers.** `AUTO`, `METAL`, `POWER`, `ENERGY`,
   `INFRA`, `REALTY`, `TECK`, `CPSE` are simultaneously `BSE_INDEX` codes and real
   equity tickers. OpenAlgo masks its BSE replace to `exchange == "BSE_INDEX"` rows
   exactly for this reason (`master_contract_db.py:250-251` comment). For this app: never
   resolve a bare symbol without a segment or exchange filter, and rank equities above
   indices on an exact tie (see 3.5).
3. **Index `instrument_key` casing is inconsistent** (`NSE_INDEX|Nifty Bank` vs
   `NSE_INDEX|NIFTY MID SELECT`). Never `.upper()` or `.title()` an instrument_key.

### 3.4 F&O contract symbols

`trading_symbol` for derivatives is a spaced contract string, `LIVE 2026-08-19`:

- FUT: `BANKNIFTY FUT 27 OCT 26` (5 parts). **The docs contain no FUT `trading_symbol`
  example anywhere**; this is live-verified, which resolves brief 4's flag that the
  5-part layout was inferred.
- CE/PE: `MIDCPNIFTY 15250 CE 27 OCT 26` (6 parts). Layout matches
  `docs/20a-option-contracts.md:24` verbatim.

`oa/database/master_contract_db.py:98-116` `reformat_symbol` reorders these positionally
to the OpenAlgo standard (`BANKNIFTY27OCT26FUT`, `MIDCPNIFTY27OCT2615250CE`). It never
reads the `expiry` or `strike_price` columns, and any row whose part count is not exactly
5 or 6 falls through unchanged.

**Recommendation: do not port `reformat_symbol` for a charting app.** It exists to hit
OpenAlgo's cross-broker symbol standard, which this app has no obligation to. Store the
raw `trading_symbol`, plus `underlying_symbol`, `expiry_date` and `strike_price` as
real columns, and build the option chain UI by querying
`WHERE underlying_key = ? AND expiry_date = ? ORDER BY strike_price` against
`idx_instruments_underlying`. That is faster, exact, and does not depend on string
layouts Upstox can change.

### 3.5 Ranked search query

Without ranking, a search for `NIFTY` AND-matches thousands of NFO option contracts and
crowds out the index and equity rows the user wants
(`oa/database/token_db_enhanced.py:466-474` comment). OpenAlgo's scoring
(`token_db_enhanced.py:496-546`) is 0 exact symbol, 1 startswith, 2 substring, 3
name/token match, ties broken by shorter symbol. Directly transplantable:

```sql
SELECT instrument_key, trading_symbol, name, segment, exchange, instrument_type
FROM instruments
WHERE suspended = 0
  AND (search_symbol LIKE :q || '%' OR name LIKE '%' || :q || '%')
ORDER BY
    CASE
        WHEN search_symbol = :q THEN 0
        WHEN search_symbol LIKE :q || '%' THEN 1
        ELSE 3
    END,
    CASE segment
        WHEN 'NSE_EQ'    THEN 0
        WHEN 'NSE_INDEX' THEN 1
        WHEN 'BSE_EQ'    THEN 2
        WHEN 'BSE_INDEX' THEN 3
        WHEN 'NSE_FO'    THEN 4
        WHEN 'BSE_FO'    THEN 5
        WHEN 'MCX_FO'    THEN 6
        ELSE 9
    END,
    LENGTH(trading_symbol)
LIMIT 30;
```

`:q` must be uppercased and space-stripped by the caller to match `search_symbol`. The
segment tiebreak is what stops `BSE_INDEX|METAL` outranking the METAL equity, and what
stops 35,584 NSE_FO rows burying `NSE_INDEX|Nifty 50`. Note that the `name LIKE '%..%'`
leg cannot use an index and will full-scan; if that is too slow, gate it behind a
minimum query length or move to FTS5.

### 3.6 The index fallback ladder

`oa/api/data.py:74-106` `_get_instrument_key` retries across the index boundary:

- exchange in `NSE|BSE|MCX` and miss -> retry `{exchange}_INDEX`
- exchange ends in `_INDEX` and miss -> retry the base exchange

Fifteen lines, large usability payoff: users type `NIFTY` and expect a chart, but the
row lives under `NSE_INDEX`, not `NSE`. **This app can largely avoid needing it** by
storing `segment` correctly and searching without an exchange filter by default, which
is why brief 4 ranks it #4 while I rank it lower. Keep it only if you add an
exchange selector to the UI.

---

## 4. Live data, ranked by cost

Ranking is value-per-dependency-cost for this app, whose hard constraint is: deps are
exactly `fastapi`, `uvicorn[standard]`, `httpx`, `pydantic`, add none.

### 4.1 Option A (recommended): REST hybrid, zero new dependencies

Reuses code that already exists in `app/upstox.py` and `app/routers/market.py`.

1. **Closed bars**: poll `/v3/historical-candle/intraday/{key}/minutes/5` every 20-30 s.
   `app/upstox.py:123-130` already implements this. These are exchange-computed bars:
   correct OHLC, correct volume, no tick aggregation, no incremental-tick carry-forward
   bug, no timezone bucketing to get wrong.
2. **Live price**: poll `/v3/market-quote/ltp` every 2-3 s
   (`docs/18c-market-quote-ltp-v3.md`). Params: `instrument_key` comma-separated, **max
   500** (`docs/18-market-quote.md:17`, error `UDAPI100043` on exceed). Returns
   `last_price`, `instrument_token`, `ltq`, `volume` (current-day cumulative), `cp`
   (previous close). Paint the in-progress bar by extending the newest candle:
   `close = last_price`, `high = max(high, last_price)`, `low = min(low, last_price)`.
3. **Fan out server-side**: one server poll loop feeding N browser tabs over a FastAPI
   `WebSocket` endpoint or plain SSE, so tabs do not each burn budget. Both are supported
   by `fastapi` + `uvicorn[standard]` with no new install.
4. **Gate the loop** on `/v2/market/status/{exchange}` (`docs/19c-exchange-status.md`) so
   it idles outside market hours.

Budget: LTP every 2 s (900 per 30 min) + intraday candles every 30 s (60) = **960 per
30 min, 48% of the 2000 limit**, leaving room for user-driven history fetches.

Dependency cost: **zero.** Latency cost: 2-3 s poll interval, the in-progress bar moves
in visible steps rather than smoothly. You also lose depth, OI, IV and Greeks. And an
undocumented risk: nothing in `docs/17b` states how fresh the currently-forming intraday
candle is, so the newest bar may lag Upstox's own aggregation by an unspecified amount.
**Unverified.** Mitigate by trusting LTP for the live price and treating the intraday
endpoint as authoritative only for **closed** bars.

The one thing `/v3/market-quote/ohlc` (`docs/18b-market-quote-ohlc-v3.md`) adds is a
genuine in-progress candle (`prev_ohlc` + `live_ohlc`, each `{open, high, low, close,
volume, ts}` with `ts` in epoch ms), but its required `interval` is `1d`, `I1`, or `I30`
only (`UDAPI1027` missing, `UDAPI1028` invalid). **There is no `I5`**, so for 5-minute
bars this endpoint alone is not sufficient.

### 4.2 Option B: V3 market-data websocket with a hand-rolled decoder

Sub-second push, `ltpc` mode, ~60-120 lines of stdlib varint/fixed64 decoding.

- `websockets 17.0.1` is **already installed** as an extra of `uvicorn[standard]`
  (`backend/uv.lock:571-573`). Zero new installs, but it is a hidden coupling to a
  transitive dep. `websockets` 17 uses `additional_headers=` on
  `websockets.asyncio.client.connect`, not the removed `extra_headers=`.
- Auth is two-step and mandatory. `docs/21b-websocket-market-auth-v3.md` documents a GET
  taking `Authorization: Bearer`, returning `data.authorized_redirect_uri`, and states
  **"The embedded `code` parameter is single-use only"** - re-authorize before every
  connect and every reconnect. **The docs never print the literal authorize URL**;
  `docs/25-api-endpoints-reference.md:129-134` lists the feed with no path. The only
  concrete source is `oa/streaming/upstox_client.py:35-36`:
  `https://api.upstox.com/v3/feed/market-data-feed/authorize`. **Do not guess a
  direct-connect wss URL** - `docs/21a:9-12` hints one might exist but no literal appears
  anywhere and OpenAlgo does not use one. **Unverified.**
- **Connection limit: 2 per user on Standard**, 5 on Plus (`docs/21a:18-30`). Footgun:
  `uvicorn --reload` can leak a socket and burn half your budget.
- **Send the subscribe JSON as a binary frame.** `docs/21a:10` says "Message Format:
  Binary (Protobuf encoded, not text)". `oa/streaming/upstox_client.py:196-198` sends
  `json.dumps(msg).encode("utf-8")` with `OPCODE_BINARY`. With `websockets`,
  `await ws.send(payload_bytes)` picks binary automatically; passing a `str` sends text
  and is the likely cause of a silent no-data connection.
- Subscribe frame (`docs/21a:32-49`):
  `{"guid":"...","method":"sub","data":{"mode":"full","instrumentKeys":["NSE_INDEX|Nifty Bank"]}}`.
  Methods `sub`, `change_mode`, `unsub`.

Modes and limits (`docs/21a:18-30,51-56`; `docs/21e:6-11`;
`oa/streaming/MarketDataFeedV3.proto:94-99`):

| Mode | Contents | Standard limit (individual / combined) |
|---|---|---|
| `ltpc` | ltp, ltt, ltq, cp. **No volume, no OHLC, no depth** | 5000 / 2000 |
| `option_greeks` | ltpc + top of book + greeks + vtt + oi + iv | 3000 / 2000 |
| `full` | ltpc + 5 depth levels + marketOHLC + atp + vtt + oi + iv + tbq/tsq | 2000 / 1500 |
| `full_d30` | as above with 30 depth levels. **Upstox Plus only** | 50 / 1500 |

Three things that will bite you:

1. **Ticks are incremental, not snapshots.** A packet updating only `marketLevel`
   arrives with **no `ltpc` at all** (proto3 omits unset/zero fields).
   `oa/streaming/upstox_adapter.py:492-505` documents this as a production bug:
   depth-only packets "were producing `Missing LTP value` validation failures". The fix
   is a per-instrument last-LTPC cache (`_last_ltpc`, `:554-564`). **Any candle builder
   must do the same or it writes zero-price bars.**
2. **`ltpc` mode gives you no volume.** Cumulative day volume `vtt` exists only in
   `MarketFullFeed`/`FirstLevelWithGreeks`. Summing `ltq` is wrong: ticks are throttled
   snapshots, not a full trade tape. A volume histogram needs `full` mode or REST, so
   you keep the intraday-candle poll anyway.
3. **Indices deliver a different oneof branch**: `FullFeed.indexFF`
   (`IndexFullFeed{ltpc, marketOHLC}`, no depth, no volume). Handle
   `marketFF or indexFF` (`oa/streaming/upstox_adapter.py:561-564,593`).

Bucketing note that matters here: IST is UTC+05:30 = 330 minutes, an exact multiple of
5, 15 and 30, so `(ltt_ms // 300_000) * 300_000` lands on the same boundaries as IST
wall clock for 1m/5m/15m/30m. **This breaks for hourly bars** (330/60 = 5.5), which must
be bucketed in IST local time. `app/config.py:31` already has `IST`.

Dependency cost: zero installs, but you own a hand-maintained wire-format decoder that
breaks silently if Upstox revises the schema, plus the carry-forward cache, plus
reconnect/backoff/re-authorize/subscription-replay machinery
(`oa/streaming/upstox_client.py:123-186,437-439`, exponential backoff base 2 max 30,
50 attempts, counter reset on every successful handshake at `:253`; subscriptions are
replayed by the client, not remembered by the server,
`oa/streaming/upstox_adapter.py:372-409`).

Also copy `_on_ws_pong`/`_on_ws_ping` feeding `_last_message_time`
(`upstox_client.py:263-280`). Without it a naive 90 s data-stall watchdog forces a
reconnect every 90 s through the whole overnight window and **re-hits the authorize
endpoint on every cycle**.

### 4.3 Option C: websocket with the `protobuf` runtime

`docs/21a:114-116`: messages need decoding with Upstox's `MarketDataFeed.proto`. The
schema is available locally at
`D:/AI Bootcamp 2026/Day13/openalgo/broker/upstox/streaming/MarketDataFeedV3.proto`
(120 lines, root message `FeedResponse`).

Using the generated `_pb2.py` requires the `protobuf` PyPI package (a C-extension
wheel). It is **not** in `backend/uv.lock`. **By the project's stated dependency rule
this option is closed.** Listed only so the tradeoff is on the record: it buys
convenience over a 120-line schema you already have on disk.

Shape note if you ever do take it: `MessageToDict` follows the proto3 JSON mapping, so
**int64 renders as JSON strings** and **zero-valued fields are omitted**. `docs/21a:82-95`
confirms: `"ltt": "1740729552723"`, `"ltq": "75"`, `"currentTs": "1740729566039"` are
quoted while `ltp: 219.3` is bare. `type` renders as the enum name (`"live_feed"`).

### 4.4 Instruments that can never be charted

`oa/api/data.py:162-165`, verbatim:

> "GLOBAL_INDICATOR feeds (USDINR, BRENTOIL, WTIOIL) are LTP-only on Upstox -
> `/v3/market-quote/ohlc` and `/v2/market-quote/quotes` both return UDAPI100500 for them.
> Short-circuit to `/v2/market-quote/ltp` and return a quote dict with only ltp
> populated."

The 3 `GLOBAL_INDICATOR` rows (`GLOBAL_INDICATOR|USDINR`, `|BZUSD`, `|CLUSD`,
`LIVE 2026-08-19`) exist in the master but have no OHLC, depth or OI. Mark them
non-chartable in search results rather than letting a user click through to a blank
chart.

Related bug worth pre-empting (`oa/api/data.py:304-305`): "Upstox bug: outer key is
`"GLOBAL_INDICATOR:null"`; match on inner instrument_token instead." **Generalised rule
for all segments: never index a market-quote response by its outer dict key.** You send
`NSE_EQ|INE002A01018` with a pipe; the response is keyed `EXCHANGE:TRADINGSYMBOL` with a
colon (`docs/18c:23` shows `"NSE_FO:NIFTY2543021600PE"`, `docs/18a:23` shows
`"NSE_EQ:NHPC"`). `docs/18b-market-quote-ohlc-v3.md` shows the outer key only as the
placeholder `"INSTRUMENT_KEY"` and never states its real format, which is precisely why
the naive approach breaks. Iterate `.values()` and match on the inner `instrument_token`
(which **is** pipe-form). OpenAlgo does this in five places.

### 4.5 Market metadata endpoints the app does not call yet

**Holidays** (`docs/19a-market-holidays.md`):
`GET /v2/market/holidays` (current year) and `GET /v2/market/holidays/{date}`. No query
params, no exchange filter; filter client-side. Fields: `date`, `description`,
`holiday_type` (`SETTLEMENT_HOLIDAY` | `TRADING_HOLIDAY` | `SPECIAL_TIMING`),
`closed_exchanges[]`, `open_exchanges[]` with `exchange`, `start_time`, `end_time` in
**epoch ms**. Decoding the doc's own sample: `1704079800000` = 09:00 IST,
`1704108600000` = 17:00 IST, so these are absolute epoch-ms, not IST-local.

Three semantics not to conflate: `TRADING_HOLIDAY` with your exchange in
`closed_exchanges` means **no candles exist**; `SETTLEMENT_HOLIDAY` means clearing is
shut but trading may run, so it is **not** a no-data day; `SPECIAL_TIMING` means the
session exists with a non-standard window from `open_exchanges[]`. The doc's own sample
is a `TRADING_HOLIDAY` that still has a non-empty `open_exchanges` for MCX, so
`holiday_type` alone is insufficient: check membership per row, per exchange. The
endpoint is current-year only with no year parameter; historical years are **not
documented, unverified**. Docs are also silent on whether it needs a Bearer header;
every other v2 endpoint does (`docs/03c-request-structure.md`), so assume yes.

**Timings** (`docs/19b-market-timings.md`): `GET /v2/market/timings/{date}`, fields
`exchange`, `start_time`, `end_time` (epoch ms). Supported: MCX, NSE, NFO, CDS, BSE, BCD,
BFO. Error `UDAPI1088` invalid date format. **The docs never state the actual session
clock times and show no JSON sample** - the times are data, not constants. There is no
documented "09:15" anywhere in the corpus; the closest anchor is
`docs/19c-exchange-status.md`'s sample `last_updated: 1705549500000` = 09:15:00 IST, but
that is a sample in a status payload, not a rule. **The response envelope shape (array
vs object) is undocumented and OpenAlgo never calls this endpoint, so there is no second
source. Verify against a live call before coding the parse. Unverified.** The single
`start_time`/`end_time` pair also cannot express pre-open, closing auction, or MCX's
split day/evening sessions; how those are represented is **undocumented**.

**Status** (`docs/19c-exchange-status.md`): `GET /v2/market/status/{exchange}`, returns
`{exchange, status, last_updated}`. Error `UDAPI1089`. **The status enum is not
documented** - only `NORMAL_OPEN` appears anywhere in the corpus.
`docs/19-market-information.md` says it reports open, closed, or pre-open, so at least
three states exist, but the literal strings are unlisted. **Do not write an exhaustive
`if status == ...` ladder**; treat anything that is not a known-open value as
not-normally-open, and log unknown values. Note the granularity mismatch: this endpoint
is keyed by **exchange**, while the websocket `market_info` message reports by
**segment** (`docs/21a:70-75`). Whether `/market/status/{exchange}` accepts segment-style
values is **undocumented, unverified**.

### 4.6 Token lifecycle: no refresh exists

- **3:30 AM IST expiry is documented.** `docs/09c-login-get-token.md:9`: the access token
  "lasts until **3:30 AM** the following day, regardless of the time it was generated".
  Corroborated by `docs/09d-login-access-token-request.md:39,70`. So
  `app/config.py:34-35` matches the docs.
- **The OAuth response never tells you the expiry.** `docs/09c` lists `email`,
  `exchanges`, `products`, `broker`, `user_id`, `user_name`, `order_types`, `user_type`,
  `poa`, `is_active`, `access_token`, `extended_token`. There is no `expires_at`,
  `issued_at`, `expires_in`, or `token_type`. Deriving locally is the only option, so
  `app/store.py:16-23` is not avoidable. Only the webhook flow returns real timestamps
  (`docs/09d`).
- **Refresh is not possible.** A grep for `refresh_token` across the entire doc corpus
  returns zero hits. `docs/02-authentication.md` documents only
  `grant_type=authorization_code`. Daily re-authorization is mandatory. Authorization
  codes "expire after single use, regardless of token generation success"
  (`docs/02-authentication.md`, Key Notes), which is why a browser refresh on
  `/api/auth/callback` produces a confusing raw Upstox error today
  (`UDAPI100057`, `docs/09c`).
- **The extended token is useless for charting.** `docs/02-authentication.md:88-98`:
  valid one year, read-only, supported APIs are exactly Get Positions, Get Holdings, Get
  Order Details, Get Order History, Get Order Book. No market data, no candles, no
  quotes. Using it on `/v3/historical-candle` yields `UDAPI100067`
  (`docs/03b-error-codes.md`). `app/store.py:62` persists it and nothing uses it. Either
  drop the column or comment it so nobody tries.
- **The long-lived token that IS useful is the Analytics Token**
  (`docs/09b-login-analytics-token.md`): one year, read-only, one per account, minted
  manually from the Developer Apps Analytics tab (no API). Supported: Quotes, OHLC V3,
  LTP V3, **HistoricalCandle V3**, **MarketDataFeed V3**, OptionGreek,
  PutCallOptionChain, OptionContracts, Brokerage, MarketStatus, CalculateMargin,
  **SearchInstruments**, MarketDataFeedAuthorize V3. Explicitly excludes orders,
  positions, holdings, funds, profile, trades. Note what is **not** on that list: market
  holidays and market timings. Whether those work with an analytics token is
  **undocumented, unverified.**

### 4.7 Error codes a charting app will actually hit

Envelope (`docs/03a-response-structure.md:33-45`):

```json
{"status":"error","errors":[{"error_code":"...","message":"...",
 "property_path":null,"invalid_value":null}]}
```

| Code | Source | Correct handling |
|---|---|---|
| HTTP 401 / `UDAPI100050` | `docs/03b` | Clear the stored session, set `connected=false`, prompt re-login. Never retry |
| `UDAPI100016` | `docs/03b` | Invalid credentials. Same as above, surface as "reconnect" |
| `UDAPI100073` | `docs/03b` | client_id inactive. Terminal: do not retry, do not clear the token, tell the user to contact Upstox |
| `UDAPI100067` | `docs/03b` | Extended token used on a market endpoint. Code bug |
| HTTP 429 / `UDAPI10005` | `docs/03b:14,24`, `docs/04` | Back off exponentially, serve the SQLite cache meanwhile. No `Retry-After` is documented |
| `UDAPI1021` | `docs/17a:56` | Pipe not URL-encoded. Code bug |
| `UDAPI100011` | `docs/17a:58` | Well-formed but unknown key: delisted, expired, or a stale local row. Re-download the master and re-resolve. **Distinct from `UDAPI1021`** |
| `UDAPI1022` / `UDAPI1015` | `docs/17a:57,59` | Missing or inverted dates. Code bug; `UDAPI1015` is reachable by naive window arithmetic near midnight IST |
| `UDAPI1146` | `docs/17a:60`, `docs/17b:29` | Invalid unit. Intraday accepts only minutes/hours/days |
| `UDAPI1147` | `docs/17a:61`, `docs/17b:30` | Invalid interval for the unit |
| `UDAPI1148` | `docs/17a:62` | Range exceeds the per-unit cap. **Fix by chunking, not retrying** |
| `UDAPI1088` / `UDAPI1089` | `docs/19b`, `docs/19c` | Bad date format / bad exchange |
| `UDAPI100069/70/57` | `docs/09c` | Bad credentials / bad redirect_uri / replayed single-use code |
| `UDAPI1169`-`UDAPI1175` | `docs/07a` | Instrument-search validation errors |
| `UDAPI100500` | `docs/03b` | Unexpected system failure. Retry once with backoff, then serve cache |

---

## 5. Correctness bugs in the app today

Numbered, each with file and line area, the wrong assumption, and the fix.

**1. Every Upstox error code is silently discarded.**
`app/upstox.py:42` reads `first.get("errorCode", "")`.
`docs/03a-response-structure.md:38,51` documents the field as `error_code` and line 58
marks `errorCode` deprecated. So `UpstoxError.code` is always `""`. Cascade:
`app/routers/market.py:193` and `app/routers/auth.py:110` both do
`f"{exc.message} ({exc.code})" if exc.code else exc.message`, so the code never reaches
the user, and no branch on `UDAPI100050` vs `UDAPI100011` vs `UDAPI10005` is possible
anywhere in the app.
**Fix:** `code=first.get("error_code") or first.get("errorCode") or ""`.

**2. A 401 mid-session leaves the app claiming it is connected.**
`app/routers/market.py:190-194` re-raises as `HTTPException(exc.status, ...)` and never
touches the stored session. `app/store.py:87-93` `active_token()` decides liveness purely
from the local clock. If the token is revoked (logout on another device, or
`UDAPI100050`), `/api/auth/status` keeps reporting `connected: true` with a healthy
countdown until 03:30 IST while every chart load fails.
**Fix:** on HTTP 401 or `UDAPI100050` or `UDAPI100016`, call `store.clear_session()`
before re-raising. Treat a 401 as the authority on expiry and the local clock only as a
pre-emptive warning. Depends on bug 1 being fixed first.

**3. The fetch window can exceed the per-unit maximum and be rejected wholesale.**
`app/routers/market.py:180` computes `from_date = today - max(sessions*3, 12) days` with
`sessions` allowed up to 30 at `:167`. At `sessions=30` that is a 90-day span. For
`unit=minutes, interval` 1-15 the cap is 1 month (`docs/17a:15`), so
`?unit=minutes&interval=5&sessions=11` and above should return `UDAPI1148`
(`docs/17a:62`). There is no chunking.
**Fix:** add a per-unit chunk table (30 / 90 / 3650 / unlimited days, section 2.3) and a
chunk loop mirroring `oa/api/data.py:568-643`, or clamp the window per unit. Clamping is
the smaller change; chunking is what actually enables deep history.

**4. The window math is meaningless for `weeks` and `months`.**
`app/routers/market.py:180` applies the same `sessions * 3` calendar-day formula for
every unit, and `_trim_to_sessions` at `:45-48` groups by calendar date. `unit=weeks,
sessions=5` fetches 15 calendar days and yields 2 or 3 bars; `unit=months, sessions=5`
yields 1. Both units are documented Unlimited back to January 2000 (`docs/17a:18-19`).
The chart silently renders fewer bars than requested with no notice.
**Fix:** split the parameter. For `days`/`weeks`/`months` interpret it as a bar count and
size the window as `count * (1 | 7 | 31) * 1.4` days; for `minutes`/`hours` keep it as a
session count. Or replace it entirely with an explicit `from`/`to` range.

**5. The `instruments` table cannot hold the master (blocking for the whole feature).**
`app/db.py:34-39` declares `symbol TEXT PRIMARY KEY`; `app/db.py:91-95` and
`app/store.py:113-123` both conflict on `symbol`. The full master has the same
`trading_symbol` on multiple segments (IDEA on NSE and BSE), plus 5 live in-segment
collisions on NSE_EQ (CHOLAFIN, ELECTCAST, MOTHERSON, IMC1, `LIVE 2026-08-19`). The
`ON CONFLICT(symbol) DO NOTHING` at `app/db.py:94` will silently discard most rows.
`app/store.py:106-110` `get_instrument(symbol)` and `app/routers/market.py:110-123`
`_resolve_instrument` and `app/schemas.py:89-94` `Instrument` all assume one row per
symbol.
**Fix:** move the primary key to `instrument_key` (verified globally unique, section 1.4)
and thread `segment` (or `exchange`) through `get_instrument`, `_resolve_instrument`, and
the `Instrument` schema. Resolve by `instrument_key` wherever the frontend can carry it.

**6. `fetch_nse_equities` downloads the wrong file and filters out most of the universe.**
`app/config.py:27-29` points at `NSE.json.gz`; `app/upstox.py:146` keeps only
`segment == "NSE_EQ" and instrument_type == "EQ"`. Consequences: no BSE, no MCX, no
`GLOBAL_*` rows at all (they exist only in `complete.json.gz`, `LIVE 2026-08-19`), and
**every index is dropped**, so NIFTY and BANKNIFTY can never be charted. The same filter
would also drop all of BSE, whose equities carry group codes not `EQ`
(`docs/07a-instrument-search.md`). `app/routers/market.py:139-159` then only re-resolves
the 5 hardcoded `SEED_INSTRUMENTS`, so `available` is reported but never stored.
**Fix:** point at `complete.json.gz` (`docs/07b:11`), filter by `segment` only, and load
all 124,738 rows using the schema and insert strategy in sections 1.4 and 1.8.

**7. The intraday endpoint is called unconditionally.**
`app/routers/market.py:197-202` always fires `intraday_candles` and swallows every error
with a bare `except upstox.UpstoxError: intraday = []`. For `unit=weeks` or `months` that
is a guaranteed `UDAPI1146` (`docs/17b:16` allows only minutes/hours/days). Outside
market hours it is a guaranteed wasted request. It doubles the request count against the
binding 2000-per-30-minutes bucket for zero benefit, and it hides genuine failures on the
units where intraday matters.
**Fix:** call it only when `unit in {"minutes","hours","days"}` **and** the window
touches today, gated on `/v2/market/status/{exchange}` (`docs/19c`) or at minimum on
`to_date == today` as `oa/api/data.py:709-712` does. Log the swallowed error instead of
discarding it.

**8. `interval` is validated by regex but never against its unit.**
`app/routers/market.py:166` uses `pattern=r"^\d{1,3}$"`, which admits `0`, `301`-`999`
for minutes, `6`-`999` for hours, and any value at all for days/weeks/months where only
`1` is legal (`docs/17a:27`). All of those come back as `UDAPI1147`.
**Fix:** validate the `(unit, interval)` pair against the section 2.2 matrix in the
router, before the HTTP call. Reject with a 422 rather than spending a rate-limited
round trip.

**9. An empty candle array is reported as a hard error.**
`app/routers/market.py:214-221` raises 404 "Upstox returned no candles for {symbol}"
when both the cache and the fetch are empty. Neither `docs/17a` nor `docs/17b` documents
any "no data for range" error; an empty `data.candles` on a holiday, a weekend, or a
pre-09:15 window is the **documented-normal success outcome** (section 2.5), and
`oa/api/data.py` `_fetch_chunk_data` treats it as such. Requesting a chart at 08:00 IST
on a Monday after a Friday holiday hard-errors on a perfectly valid symbol.
**Fix:** return 200 with an empty `candles` list and a `notice` explaining the window
contained no trading days. Reserve 404 for an unresolvable symbol.

**10. Token expiry derivation is wrong by 24 hours for tokens issued before 03:30 IST.**
`app/store.py:16-23` maps a token issued at 02:00 IST to 03:30 the **same** morning,
because `issued >= cutoff` is false so the cutoff stays on today.
`docs/09c-login-get-token.md:9` says "3:30 AM **the following day**, regardless of the
time it was generated", which puts a 02:00 token at 03:30 tomorrow. The docs do not
resolve the edge case. The app's reading fails in the safe direction (early rather than
late), but the countdown and `lifetimeFraction` progress bar in
`frontend/src/components/session-provider.tsx` will show ~90 minutes of life on a token
that in fact has 25.5 hours.
**Fix:** follow the doc literally (always the next calendar day's 03:30), and pair it
with bug 2's fix so a real 401 is what actually disconnects the session. Note the two
readings genuinely conflict and only a live 02:00 IST login settles it. **Unverified.**

**11. Nothing enforces the rate limit anywhere.**
Two upstream calls per chart load (`app/routers/market.py:182,198`), no throttle, no
backoff, no 429 handling, and `frontend/src/components/session-provider.tsx:45` polls
`/api/auth/status` every 60 s. `docs/04-rate-limits.md:37` warns that exceeding limits
"might result in temporary suspension of access", so a rapid symbol-switching or
multi-tab session is actively dangerous, not merely throttled.
**Fix:** a single shared async semaphore plus a token-bucket sized to the binding 2000
per 30 min (1.11 req/s sustained), and an exponential backoff on 429 / `UDAPI10005` that
serves the SQLite cache while backing off.

**12. The candle cache is written but never used to avoid refetching.**
`app/routers/market.py:205` saves the merged set, but `:209-211` only reads the cache
when the fetch produced nothing. Every request refetches the whole window even though
`app/store.py:149-160` already dedupes on `(instrument_key, unit, interval, ts)`, which
is exactly the right shape for incremental paging.
**Fix:** read the newest cached `ts` first and request only `newest_ts .. today`,
falling back to the full window on a cold cache. This is the single largest reduction in
rate-limit pressure available.

**13. `sync_log` and `candles` grow without bound.**
`app/store.py:163-167` appends one `sync_log` row per fetch, and `app/db.py:41-53`
`candles` has no eviction policy. With the master added (15-25 MB) plus deep history,
`backend/upstox.db` grows monotonically.
**Fix:** cap `sync_log` (keep the newest N per key, or collapse it to an upsert like
`instrument_sync`), and add a retention rule on `candles` for intraday units.

**14. Session summaries assume the first returned bar is the session-open bar.**
`app/routers/market.py:61` computes `open_ = float(bars[0][1])` after grouping by
`iso[:10]`, with no check that `bars[0]` is actually the 09:15 bar. On a `SPECIAL_TIMING`
day (`docs/19a`, Muhurat trading) or after a partial fetch, the reported session open is
whatever bar happened to come back first.
**Fix:** either take the open from the daily candle for that date, or mark the summary
partial when the first bar's time is later than the session start from
`/v2/market/timings/{date}` (`docs/19b`). Low severity, but it silently mislabels data.

**15. No session metadata at all, so the chart cannot render gaps or session boundaries.**
Neither `/v2/market/timings/{date}` nor `/v2/market/status/{exchange}` nor
`/v2/market/holidays` is called anywhere; `app/config.py:21-29` defines only auth,
profile, logout, historical, intraday and the NSE instrument URL. The 09:15 open exists
only as prose in `frontend/src/components/candle-chart.tsx:24-27`. Consequences: a
`SPECIAL_TIMING` day renders as a stray cluster in the wrong part of the axis, a half-day
session is indistinguishable from a data outage, and holiday gaps draw as flat spans.
**Fix:** fetch holidays once per day and cache them in SQLite; use them for window math
(walk back counting only real trading days) and for gap collapsing in the renderer.
Verify the `/v2/market/timings` response envelope against a live call first, since it is
undocumented (section 4.5).

---

## 6. Recommended roadmap

Ordered by value-to-effort for a charting app. Bug numbers refer to section 5.

### Phase 1: unblock the actual feature request (bugs 5, 6, 1)

1. **Fix `error_code`** (bug 1). One line in `app/upstox.py:42`. Everything downstream
   that branches on an Upstox error depends on it, so do it first.
2. **Rewrite the `instruments` table** on `instrument_key` (bug 5), using the section 1.4
   schema. Thread `segment` through `get_instrument`, `_resolve_instrument`, and the
   `Instrument` schema.
3. **Download `complete.json.gz` into SQLite** (bug 6): section 1.1 URL, section 1.8
   insert strategy, section 1.9 conditional-GET policy. Run it from the FastAPI lifespan
   hook **and** the OAuth callback as a background task, because the asset needs no token.
   Add a `GET /api/market/instruments/status` the UI can poll while the first load runs
   (pattern from `openalgo/blueprints/master_contract_status.py:188`).
4. **Ranked symbol search endpoint** using the section 3.5 query. Without ranking a
   search box over 124k rows is unusable for exactly the symbols people search most.

At the end of phase 1 the user can search and chart any Upstox instrument, which is the
whole stated feature request.

### Phase 2: make the candle fetch correct (bugs 3, 4, 7, 8, 9, 12)

5. **Validate `(unit, interval)` before the HTTP call** (bug 8). Cheapest correctness win
   on the list.
6. **Per-unit window sizing and chunking** (bugs 3 and 4) from the section 2.3 table.
   This is what unlocks `weeks`, `months`, and deep daily history.
7. **Gate the intraday call** on unit and on the window touching today (bug 7). Halves
   the upstream request count on most loads.
8. **Serve empty windows as 200 with a notice** (bug 9).
9. **Incremental paging off the cache** (bug 12): read the newest cached `ts`, fetch only
   the gap. Largest single reduction in rate-limit pressure.

### Phase 3: make it safe to run continuously (bugs 2, 11, 10)

10. **Rate limiter and 429 backoff** (bug 11), sized to 1.11 req/s sustained.
11. **Clear the session on 401** (bug 2). Depends on step 1.
12. **Token expiry per the doc's literal reading** (bug 10).

### Phase 4: live data (section 4.1)

13. **REST hybrid live loop**: intraday-candle poll every 20-30 s for closed bars, LTP v3
    poll every 2-3 s for the in-progress bar, fanned out to browsers over one FastAPI
    WebSocket or SSE endpoint. Zero new dependencies, 48% of the rate budget.
14. **Match quote responses on the inner `instrument_token`**, never the outer dict key
    (section 4.4). Cheap on day one, silently corrupts multi-symbol watchlists otherwise.
15. **Market-status gate** on the poll loop (`docs/19c`) so it idles outside market hours.

### Phase 5: polish (bugs 13, 14, 15)

16. **Holiday-aware window math and gap rendering** (bug 15, section 4.5).
17. **Retention on `candles` and `sync_log`** (bug 13).
18. **Honest session-open handling** (bug 14).

### Explicitly deferred or rejected

- **The `protobuf` websocket** (section 4.3). Violates the dependency rule.
- **A hand-rolled protobuf decoder** (section 4.2). Only if sub-second push becomes a
  hard requirement. It still gives no volume in `ltpc` mode, so you keep the intraday
  poll anyway.
- **OpenAlgo's `reformat_symbol`** (section 3.4). Solves a cross-broker standardisation
  problem this app does not have.
- **OpenAlgo's index replace tables** (section 3.3). Verified stale against today's file.
- **OpenAlgo's `NSE_COM` drop** (section 1.3). An OpenAlgo namespace decision, not an
  Upstox limitation.
- **OpenAlgo's synthesised daily bar for today** (section 2.6, `oa/api/data.py:770-863`).
  The fiddliest code in that file and the one most likely to draw a phantom bar.

---

## 7. Where the briefs contradicted each other

Stated plainly, with the call and the reason.

| Disagreement | Brief 1 | Brief 4 | Call |
|---|---|---|---|
| NSE index `trading_symbol` | Already normalised: `NIFTY`, `BANKNIFTY`. OpenAlgo's table is stale | Carries the spaced human name `NIFTY 50`; needs a 60-entry replace table | **Brief 1.** `LIVE 2026-08-19` shows `trading_symbol` = `NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`. Brief 4 is relaying OpenAlgo code that has gone stale. Caveat: `INDIA VIX` still has a space, so brief 4's instinct is not entirely wrong, and BSE index codes still collide with equity tickers |
| BSE index codes | not covered | `SNSX50 -> SENSEX50` needed | **Neither exactly.** `LIVE 2026-08-19`: no `SNSX50` row exists; the file publishes `SENSEX50` directly. `SNXT50`, `SNSX60`, `SNXN30`, `MID150`, `IND150` are still cryptic and still collide (`AUTO`, `METAL`, `POWER`) |
| Suspended-list impact | Subtracting it removes ~26.7k dead NSE tickers from search | not covered | **Brief 1 is wrong.** `LIVE 2026-08-19`: only **5,921** of the 33,718 suspended keys appear in `complete.json.gz`. Upstox already excludes the rest. Keep the flag; do not expect a bulk filter |
| Field count in `complete.json.gz` | 35 distinct keys | 15-ish per the doc | **Neither.** `LIVE 2026-08-19` counts **34**. Brief 1 appears to have merged in `intraday_margin`/`intraday_leverage` from the `*_MIS` files |
| Primary key for `instruments` | `instrument_key` (verified unique) | `(symbol, exchange)` composite, keeping `brsymbol` | **Brief 1.** Both correctly identify that `symbol` alone is broken, but `(symbol, exchange)` still collides: `LIVE 2026-08-19` finds 5 in-segment `trading_symbol` duplicates on NSE_EQ alone. Only `instrument_key` is verified globally unique (124,738 / 124,738) |
| Whether the docs' "Max Records" column is a span cap or a row cap | reads it as a span cap via OpenAlgo | same | **Both agree, but the doc itself is ambiguous** (`docs/17a:13` heads the column "Max Records" while its cells are durations). Trust OpenAlgo's span reading because it is production code hitting the live API, but treat it as **unverified** and let `UDAPI1148` be the runtime authority |
| Whether `_merge` keeps the fresher bar | brief 2 says dedupe should keep the intraday copy | brief 4 says the app's two-call merge "is correct" | **No conflict in practice.** `app/routers/market.py:204` passes `_merge(historical, intraday)` and `_merge` at `:35-42` lets later groups overwrite, so intraday already wins. The residual risk is that `_merge` keys on the raw ISO string, so two endpoints returning different string forms for the same instant would not dedupe. Normalise to epoch at ingest to remove the risk |

Briefs 2, 3 and 5 do not contradict each other or the others on any material point; where
they overlap (rate limits, error codes, the intraday-vs-historical cutover) they agree.
