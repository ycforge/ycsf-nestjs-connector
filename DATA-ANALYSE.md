# DATA-ANALYSE.md

Forensic/schema analysis of **real captured Yandex Cloud Functions invocation dumps**,
produced as the evidence base for the runtime facts referenced in
[AGENTS.md](./AGENTS.md) (§4 Runtime facts, §5 Context model, §14.3 Regression fixtures,
§15 Testing captured Yandex events).

## Provenance

| Item           | Value                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Source dataset | local capture archive (not part of this repository)                                                       |
| Capture method | Cloud Function dumping its own `(event, context)` as JSON, one file per invocation                        |
| Files read     | **97**, recursively; **97 valid JSON, 0 invalid**; no auxiliary files present                             |
| Samples        | **46** HTTP / API Gateway (root dir), **51** Message Queue trigger (`m-queue/`)                           |
| Time range     | 2026-08-21T16:16:31.808Z → 2026-08-21T21:45:37.686Z                                                       |
| Node.js        | `v22.15.0` (only version observed)                                                                        |
| Method         | Every file parsed; union of all recursive paths computed; cross-field relations verified programmatically |

Every claim below is `observed` unless explicitly marked `[inferred]` or `[unknown]`.
Counts reconcile: 46 + 51 = 97.

> **Sensitive values note.** Values below were captured from a private test stand.
> `context.token` is `[REDACTED]` in the dumps themselves; `Authorization`/`Cookie`
> examples are synthetic test values; the client IP, hostnames and resource ids are real
> captured identifiers. Do not copy them into committed test fixtures unsanitized —
> follow AGENTS.md §6.3 placeholders instead.

---

## A. DATASET OVERVIEW

| Metric                                    | Value                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| Total files                               | 97 (`invocation-<ts>-<uuid>.json`, single-line minified JSON)  |
| Valid / invalid JSON                      | 97 / 0                                                         |
| HTTP / API-Gateway samples                | 46 (detected by presence of `event.version` + `event.rawPath`) |
| Message Queue samples                     | 51 (detected by presence of `event.messages`)                  |
| Other invocation categories               | none observed                                                  |
| Dump top-level keys (identical in all 97) | `timestamp`, `node`, `event`, `context`                        |

Constants across the whole dataset: one function id `d4e0gm3s8nvcm9vjp456`, one folder
`b1g9kusggl9k4bmurq6s`, one cloud `b1gcl2e79anlps1cbd8n`, one gateway host
`d5dt7i8jhtbf7appd6jm.0ly8ed4d.apigw.yandexcloud.net`. Two deployed versions:
HTTP used `d4eu4mg45akicl7ad5ta`, queue used `d4e52r6cc961n7lhu51h`.

---

## B. EXACT HTTP EVENT SCHEMA (46 samples)

Presence classes: **always** = 46/46; **conditional** = driven by request content.

### B1. Always-present paths

| JSON path                                          | JS type        | Constancy           | Observed values / constraints                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                                          | string         | constant `"2.0"`    |                                                                                                                                                                                                                                                                                                                                |
| `rawPath`                                          | string         | variable            | decoded path **without query**; len 1–28 in dataset; may contain spaces, non-ASCII (`/unicode/тест/привет`) and even a decoded `?chars` fragment when the client percent-encoded the `?`                                                                                                                                       |
| `rawQueryString`                                   | string         | variable            | raw still-encoded query, no leading `?`; `""` when absent (len 0–95); percent-encoding preserved verbatim                                                                                                                                                                                                                      |
| `headers`                                          | object         | variable keys       | flat `string→string`; **no array values anywhere**; keys Pascal-Cased (`X-Request-Id`, `Uber-Trace-Id`) `[inferred normalization]`                                                                                                                                                                                             |
| `queryStringParameters`                            | object         | variable            | decoded `string→string`; `{}` allowed; empty value → `""`; **repeated params comma-joined** (`multi=one&multi=two&multi=three` → `"one,two,three"`); ambiguity hazard if values contain commas                                                                                                                                 |
| `requestContext.authorizer`                        | object         | constant            | `{}` — present-but-empty (no authorizer configured)                                                                                                                                                                                                                                                                            |
| `requestContext.http.method`                       | string         | variable            | observed: GET×17, POST×21, PUT×2, PATCH×2, DELETE×2, OPTIONS×1, HEAD×1                                                                                                                                                                                                                                                         |
| `requestContext.http.path`                         | string         | variable            | **unreliable**: rebuilt path+query; trailing `?` appended even when query empty; param order sometimes reordered/sorted; `/curl-data` case shows space→`+` and lowercase percent hex; unicode segments decoded here but percent-encoded in `X-Envoy-Original-Path`                                                             |
| `requestContext.http.sourceIp`                     | string         | constant in dataset | IPv4 string                                                                                                                                                                                                                                                                                                                    |
| `requestContext.http.userAgent`                    | string         | constant in dataset | duplicates `User-Agent` header                                                                                                                                                                                                                                                                                                 |
| `requestContext.requestId`                         | string UUID v4 | variable            | == `headers["X-Request-Id"]`                                                                                                                                                                                                                                                                                                   |
| `requestContext.time`                              | string         | variable            | CLF-style `"21/Aug/2026:16:16:30 +0000"` (second precision)                                                                                                                                                                                                                                                                    |
| `requestContext.timeEpoch`                         | **number**     | variable            | Unix **seconds** (10 digits, 1787328990…1787329042) — NOT ms despite AWS-v2.0-style naming `[inferred semantics]`                                                                                                                                                                                                              |
| `requestContext.apiGateway.operationContext.probe` | object         | constant in dataset | `{"source":"curl","test":true,"version":"1.0"}`; likely tied to gateway console/probe traffic `[inferred]`; absence in production traffic `[unknown]`                                                                                                                                                                          |
| `body`                                             | string         | variable            | `""` when none; plain text iff `Content-Type: application/json`, else Base64 (see §E1)                                                                                                                                                                                                                                         |
| `isBase64Encoded`                                  | **boolean**    | variable            | `true` for every non-JSON request **including all bodiless GET/DELETE/HEAD/OPTIONS**; `false` only for `application/json` bodies (12 samples)                                                                                                                                                                                  |
| `pathParameters`                                   | object         | variable            | catch-all param `{"ID":"<whole path without leading />"}`; `{"ID":""}` for path `/`; `%2F` decodes and merges segments (`/a%2Fb%2Fc` → `ID:"a/b/c"`)                                                                                                                                                                           |
| `parameters`                                       | object         | variable            | merge of **spec-declared** params only: path params + selected query (`q`,`flag`) + selected headers (`X-Test-Header`) + selected cookies (`test_cookie`); undeclared ones excluded (proved: `X-Flag`,`X-Tag` absent from `parameters` on `/repeated-headers`); repeated query param → **last value only** (`"multi":"three"`) |
| `multiValueParameters`                             | object         | variable            | same sources, values `string[]`; repeats preserved fully (`multi:["one","two","three"]`); singletons are length-1 arrays                                                                                                                                                                                                       |
| `operationId`                                      | string         | constant in dataset | 64-char lowercase hex, same for all requests to this spec                                                                                                                                                                                                                                                                      |

### B2. Constant injected headers (16, present 46/46)

```text
Accept, Host, Traceparent, Tracestate, Uber-Trace-Id, User-Agent,
X-Api-Gateway-Function-Id, X-Envoy-External-Address, X-Envoy-Original-Path,
X-Forwarded-For, X-Forwarded-Proto, X-Real-Remote-Address, X-Request-Id,
X-Serverless-Certificate-Ids, X-Serverless-Gateway-Id, X-Trace-Id
```

Notable fixed/derived values:

- `Tracestate` — always `""` (present-but-empty);
- `X-Serverless-Certificate-Ids` — always literal `"{}"` (JSON-in-string, empty);
- `Traceparent` — `00-0000000000000000<trace16hex>-<span16hex>-01`, trace part zero-padded from Uber trace id;
- `Uber-Trace-Id` first segment == first segment of `context.uberTraceId` in **46/46** cases, span/parent differ;
- `X-Real-Remote-Address` — `ip:port`, port varies per request;
- `X-Api-Gateway-Function-Id` (`d4epk2u927vj48ptg4i6`) differs from `context.functionName` — the gateway routes through its own integration id `[inferred]`;
- `Content-Length` — string digits, present 26/46 (absent on GETs, `"0"` on OPTIONS);
- `Content-Type` — present 25/46: `application/json`, `text/plain`, `application/x-www-form-urlencoded`, `application/octet-stream`, `application/custom+json`.

Conditional client headers seen once each: `Authorization` (masked `Bearer ****`),
`Origin`, `Referer`, `Access-Control-Request-Method`, `Access-Control-Request-Headers`,
plus custom names `X-Test`, `X-Test-Two`, `X-Number`, `X-Special`, `X-Custom-Boolean`,
`X-Custom-Number`, `X-Flag`, `X-Tag`, `X-Test-Header` (×4), `Cookie` (×4).

### B3. Arrays under HTTP event

| Array path                             | Occurrences | Length min/max | Element schema           | Homogeneous |
| -------------------------------------- | ----------- | -------------- | ------------------------ | ----------- |
| `multiValueParameters.ID[]`            | 45          | 1/1            | string                   | yes         |
| `multiValueParameters.q[]`             | 3           | 1/1            | string                   | yes         |
| `multiValueParameters.X-Test-Header[]` | 4           | 1/1            | string                   | yes         |
| `multiValueParameters.test_cookie[]`   | 2           | 1/1            | string                   | yes         |
| `multiValueParameters.multi[]`         | 1           | **3/3**        | string (`one,two,three`) | yes         |
| `multiValueParameters.flag[]`          | 1           | 1/1            | string                   | yes         |

---

## C. EXACT MESSAGE QUEUE EVENT SCHEMA (51 samples)

Top-level structure: the event has **exactly one key — `messages`** (array).
All other HTTP fields are absent.

| JSON path                               | JS type        | Presence | Notes                                                                                                                                                                                                                        |
| --------------------------------------- | -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`                              | array          | 51/51    | length **1 in every sample** (min=max=avg=1); array contract implies batching capability, max batch size `[unknown]`                                                                                                         |
| `messages[].event_metadata`             | object         | always   | per-message envelope                                                                                                                                                                                                         |
| `....event_metadata.event_id`           | string         | always   | hyphen-hex 4 groups, total length 33–35 (**not** an RFC-4122 UUID); **identical to `details.message.message_id` in 51/51**                                                                                                   |
| `....event_metadata.event_type`         | string         | always   | constant `"yandex.cloud.events.messagequeue.QueueMessage"`                                                                                                                                                                   |
| `....event_metadata.created_at`         | string         | always   | ISO-8601 ms `2026-08-21T21:44:34.266Z`; equals `SentTimestamp` epoch-ms in **51/51**                                                                                                                                         |
| `....event_metadata.tracing_context`    | **null**       | always   | null in 51/51 (present-with-null ≠ absent)                                                                                                                                                                                   |
| `....event_metadata.cloud_id`           | string(20)     | always   | constant                                                                                                                                                                                                                     |
| `....event_metadata.folder_id`          | string(20)     | always   | constant                                                                                                                                                                                                                     |
| `messages[].details.queue_id`           | string         | always   | `yrn:yc:ymq:ru-central1:b1g9kusggl9k4bmurq6s:f-test` (format `yrn:yc:ymq:<region>:<folder>:<queue-name>` `[inferred]`)                                                                                                       |
| `messages[].details.message.message_id` | string         | always   | === `event_id`                                                                                                                                                                                                               |
| `....message.md5_of_body`               | string(32 hex) | always   | recomputed over UTF-8 bytes of `body` — matches in **51/51**                                                                                                                                                                 |
| `....message.body`                      | string         | always   | UTF-8 text, **never base64**, no encoding flag exists; len 2–148 in dataset; arbitrary content (plain, JSON, Cyrillic, emoji, CJK/Arabic, escaped chars)                                                                     |
| `....message.attributes`                | object         | always   | system attributes; **all values strings**: `ApproximateFirstReceiveTimestamp` (epoch-ms str), `ApproximateReceiveCount` (`"1"` everywhere — no redeliveries captured), `SenderId` (constant), `SentTimestamp` (epoch-ms str) |
| `....message.message_attributes`        | object         | always   | user attributes map; `{}` or named entries `{data_type, string_value}`; observed `data_type` ∈ {`String`,`Number`}; `binary_value`/custom types never observed `[unknown]`                                                   |
| `....message.md5_of_message_attributes` | string         | always   | `""` (empty string) when no attributes; 32-hex otherwise (2 samples)                                                                                                                                                         |

**Never observed in queue events** (do not rely on): receipt handle, visibility timeout,
queue URL/ARN, region name, explicit batch-size field, dead-letter info.
Delivery/retry info exists only as `ApproximateReceiveCount`; receive delay
(`FirstReceive−Sent`) ranged 104–10482 ms. One _producer-side_ message carried custom
attributes `Scenario="retry"`, `Attempt="1"` — sent by the producer, not the trigger.

---

## D. EXACT CONTEXT SCHEMA (97/97 identical key set in both modes)

| Path                 | JS type        | Presence | Constancy       | Examples / notes                                                                                                                                                          |
| -------------------- | -------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awsRequestId`       | string UUID v4 | 97/97    | variable        | == `requestId` (97/97) == filename UUID (97/97)                                                                                                                           |
| `requestId`          | string UUID v4 | 97/97    | variable        | duplicate representation of `awsRequestId`                                                                                                                                |
| `invokedFunctionArn` | string         | 97/97    | constant        | **bare function id**, not an ARN: `d4e0gm3s8nvcm9vjp456`                                                                                                                  |
| `functionName`       | string         | 97/97    | constant        | same bare id (duplicated field)                                                                                                                                           |
| `functionVersion`    | string         | 97/97    | per deploy      | HTTP: `d4eu4mg45akicl7ad5ta`; Queue: `d4e52r6cc961n7lhu51h`                                                                                                               |
| `functionFolderId`   | string(20)     | 97/97    | constant        |                                                                                                                                                                           |
| `memoryLimitInMB`    | **string**     | 97/97    | constant        | `"1024"` — string, NOT number                                                                                                                                             |
| `deadlineMs`         | **number**     | 97/97    | variable        | absolute epoch-ms deadline; `deadlineMs − dump timestamp` ∈ [4831, 4989] ⇒ ~5 s configured timeout `[inferred]`                                                           |
| `logGroupName`       | string         | 97/97    | constant-empty  | `""` (present-but-empty, not absent)                                                                                                                                      |
| `token`              | string         | 97/97    | unknown content | captured as literal `[REDACTED]` (redacted pre-dump); IAM token for YC API access `[inferred from naming/ecosystem]` — **sensitive**                                      |
| `uberTraceId`        | string         | 97/97    | variable        | `<trace16hex>:<span16hex>:<parent16hex>:1` (len 52); trace segment matches HTTP `Uber-Trace-Id` header (46/46) with fresh span; queue traces unrelated to message content |
| `_data`              | object         | 97/97    | —               | **deep-equal to `event` in 97/97** (verified by serialized comparison) — undocumented internal runtime duplicate                                                          |

No other context keys exist in any file. No `clientContext`, no `identity`;
non-serializable function-object methods (e.g. a `getRemainingTimeInMillis` analog)
cannot appear in a JSON dump — their existence is `[unknown]`.

---

## E. BEHAVIORAL FINDINGS RELEVANT TO THE ADAPTERS

### E1. Body encoding rule (strongest empirical finding)

| Content-Type                             | `body` form                                                                              | `isBase64Encoded` |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `application/json`                       | plain UTF-8 string (objects, arrays, bare `null`, unicode+emoji, escapes)                | `false`           |
| `text/plain`                             | Base64 (`SGVsbG8sIFlhbmRleCBDbG91ZCBGdW5jdGlvbiE=` → `Hello, Yandex Cloud Function!`)    | `true`            |
| `application/x-www-form-urlencoded`      | Base64 (`name=Alice&age=30&active=true&tag=one&tag=two`); **not pre-parsed**             | `true`            |
| `application/octet-stream`               | Base64 of raw bytes (`AAECA3+A/w==` → `00 01 02 03 77 80 ff`; non-UTF-8 survives intact) | `true`            |
| `application/custom+json`                | Base64 (**not** treated as JSON despite the suffix)                                      | `true`            |
| _no Content-Type_ (POST with plain body) | Base64                                                                                   | `true`            |
| _no body_ (GET/DELETE/HEAD/OPTIONS)      | `""`                                                                                     | **`true`**        |

⇒ The flag tracks "not application/json", not actual encoding. Decode strictly via
`isBase64Encoded`; empty-body requests still arrive flagged `true`.

### E2. Query parameter multiplicity

`?a=1&a=2&a=3&a=4&a=5` yields simultaneously:

- `queryStringParameters.a === "1,2,3,4,5"` (comma-joined),
- `multiValueParameters.a === ["1","2","3","4","5"]`,
- nothing in `parameters` unless declared in the gateway spec.

Empty values survive: `empty=` → `{"empty":""}`.
Decoding verified: `hello%20world`→space, `%F0%9F%98%80`→😀, `%2F%3F%26%3D%25%23%2B`→`/?&=%#+`, `%D1%82%D0%B5%D1%81%D1%82`→`тест`.

### E3. Canonical URI

Use `rawPath` + `rawQueryString`. `requestContext.http.path` demonstrably:
appends trailing `?` (`"/test/simple?"`), reorders/sorts params (`one..seven`
alphabetized), rewrites spaces to `+` and lowercases percent-hex in some cases.
`X-Envoy-Original-Path` keeps the percent-encoded original target including query.
An encoded `%3F` decodes **into** `rawPath`: URL `/path/with%20space/and%2Fencoded%3Fchars?x=…`
→ `rawPath === "/path/with space/and/encoded?chars"`, `pathParameters.ID` includes the fragment.

### E4. Parameters merging (spec-declared only)

Observed merges into `parameters`/`multiValueParameters`: catch-all path param `ID`,
declared query params (`q`, `flag`), declared header (`X-Test-Header`), declared cookie
(`test_cookie`). Undeclared headers/queries are excluded (`X-Flag`, `X-Tag` provably
excluded). Cookies are **not** parsed anywhere else — only the raw `Cookie` header string
(`test_cookie=cookie-value; session=abc123; theme=dark`).

### E5. Tracing propagation

HTTP: three correlated representations (`Traceparent`, `Uber-Trace-Id` header,
`context.uberTraceId`) sharing the trace id but with distinct spans.
Queue: `tracing_context` is always `null`; `context.uberTraceId` exists but correlates
with nothing in the message.

---

## F. CROSS-MODE COMPARISON

| Field/path                                                                                                                                                          | HTTP       | Queue      | Both       | Notes                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---------- | ----------------------------------------- |
| `timestamp`,`node` (dump envelope)                                                                                                                                  | ✔          | ✔          | ✔          | identical semantics                       |
| `context.awsRequestId/requestId`                                                                                                                                    | ✔          | ✔          | ✔          | same format & duplication                 |
| `context.functionName`==`invokedFunctionArn`                                                                                                                        | ✔          | ✔          | ✔          | both bare ids                             |
| `context.functionVersion`                                                                                                                                           | `d4eu4mg…` | `d4e52r6…` | ✔ (type)   | different deployments per mode            |
| `context.functionFolderId/memoryLimitInMB/logGroupName/token/uberTraceId/deadlineMs/_data`                                                                          | ✔          | ✔          | ✔          | identical types & behavior                |
| `event.version/rawPath/rawQueryString/headers/queryStringParameters/requestContext/body/isBase64Encoded/pathParameters/parameters/multiValueParameters/operationId` | ✔          | ✘          | HTTP-only  | —                                         |
| `event.messages[]`                                                                                                                                                  | ✘          | ✔          | Queue-only | —                                         |
| Type-changing shared fields                                                                                                                                         | —          | —          | none       | no shared field changes type across modes |

---

## G. VALUE PATTERNS

| Pattern                                     | Fields                                                                   | Example                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| UUID v4                                     | `awsRequestId`, `requestId`, `X-Request-Id`, `X-Trace-Id`                | `f18fed85-7096-4f0e-a6db-e2c5e37e925f`                    |
| Pseudo-UUID (33–35 chars, irregular groups) | `event_id`, `message_id`                                                 | `b237b8ea-56142e72-6eeac5af-d4878d7a`                     |
| Epoch seconds (number)                      | `requestContext.timeEpoch`                                               | `1787328990`                                              |
| Epoch ms (number)                           | `deadlineMs`                                                             | `1787328996791`                                           |
| Epoch ms (string)                           | `SentTimestamp`, `ApproximateFirstReceiveTimestamp`                      | `"1787348674266"`                                         |
| YRN resource id                             | `queue_id`                                                               | `yrn:yc:ymq:ru-central1:b1g9kusggl9k4bmurq6s:f-test`      |
| Opaque 20-char ids                          | cloud/folder/function/gateway/version ids                                | `b1g9kusggl9k4bmurq6s`, `d4epk2u927vj48ptg4i6`            |
| W3C traceparent                             | `Traceparent`                                                            | `00-0000000000000000195befaa12da73b5-51fd8f610489319b-01` |
| Uber trace                                  | `Uber-Trace-Id`, `uberTraceId`                                           | `195befaa12da73b5:59ea0be13cb39c87:41d0f3eae511878e:1`    |
| MD5 hex                                     | `md5_of_body`, `md5_of_message_attributes`                               | `5d41402abc4b2a76b9719d911017c592`                        |
| 64-char hex                                 | `operationId`                                                            | `41cf33042e33…1295`                                       |
| ip[:port]                                   | `sourceIp`, `X-Forwarded-For`, `X-Real-Remote-Address`                   | `203.0.113.10`, `203.0.113.10:50384`                      |
| Real JSON booleans                          | `probe.test`, `isBase64Encoded`                                          | `true/false`                                              |
| Numbers-as-strings trap                     | `memoryLimitInMB`, all YMQ `attributes.*`, `data_type`, `Content-Length` | `"1024"`, `"1"`, `"Number"`                               |

---

## H. SECURITY / SENSITIVE FIELDS

| Path                                                                                                   | Type   | Masked example                       | Why sensitive                                                     |
| ------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------ | ----------------------------------------------------------------- |
| `context.token`                                                                                        | string | `[REDACTED]` (pre-masked at capture) | IAM token for YC API auth; true format `[unknown]`                |
| `headers.Authorization`                                                                                | string | `Bearer ****`                        | bearer credential (value was dummy `test-token`)                  |
| `headers.Cookie`                                                                                       | string | `session=***; theme=***`             | session identifiers / personal state                              |
| `requestContext.http.sourceIp`, `X-Forwarded-For`, `X-Envoy-External-Address`, `X-Real-Remote-Address` | string | `203.0.113.x`                        | personal data (client IP)                                         |
| `queue_id`, cloud/folder/function/gateway ids                                                          | string | shown                                | account-infrastructure identifiers (low sensitivity, identifying) |

No other secret-like values found in any of the 97 files.

---

## I. ANOMALIES AND SURPRISES

1. `isBase64Encoded:true` for empty/bodiless GET requests — flag tracks "not application/json", not actual encoding.
2. `requestContext.timeEpoch` is in **seconds** although AWS API-Gateway-v2 (which this format imitates) uses ms.
3. Trailing `?` in `requestContext.http.path` when query empty; reordered/lowercased/`+`-encoded reconstruction — unreliable for routing.
4. `_data` — undocumented internal context field duplicating the entire event verbatim (97/97 deep-equal).
5. `invokedFunctionArn` is not an ARN — bare 20-char id, duplicated by `functionName`.
6. `memoryLimitInMB` is a string (`"1024"`).
7. Message ids are pseudo-UUIDs (33–35 chars); `event_id`===`message_id` — redundant representation.
8. `md5_of_message_attributes:""` (empty string, not null) when no attributes.
9. Repeated query params silently comma-joined in `queryStringParameters` — ambiguous if values contain commas; only `multiValueParameters` disambiguates.
10. `parameters` contains only spec-declared entries; undeclared headers/cookies/queries excluded (proved by exclusion of `X-Flag`/`X-Tag`).
11. Encoded `?` decodes into `rawPath` — path parsing hazard.
12. `application/custom+json` was Base64-encoded — only exact `application/json` gets plain-text treatment.
13. Malformed body passed verbatim: `/combined` body `{"body":"value"}&` with JSON content-type — no validation.
14. Three different "empty" representations coexist: `authorizer:{}`, `Tracestate:""`, `logGroupName:""`.
15. `X-Serverless-Certificate-Ids:"{}"` — JSON serialized inside a header string.
16. `X-Api-Gateway-Function-Id` ≠ `context.functionName` — gateway routes via its own integration id `[inferred]`.
17. No `multiValueHeaders` counterpart despite `multiValueParameters` existing.

---

## J. RECONSTRUCTED SCHEMAS (TypeScript-oriented)

```ts
// Dump envelope (both modes)
interface InvocationDump {
  timestamp: string; // ISO-8601 UTC with ms, e.g. "2026-08-21T16:16:31.808Z"
  node: string; // observed: "v22.15.0"
  event: HttpEventV2 | QueueEvent;
  context: FunctionContext;
}

// HTTP event — every field below ALWAYS present (46/46); conditional contents noted
interface HttpEventV2 {
  version: "2.0";
  rawPath: string; // decoded, no query
  rawQueryString: string; // "" allowed
  headers: Record<string, string>; // flat; NO arrays; Pascal-Cased keys
  queryStringParameters: Record<string, string>; // decoded; repeats comma-joined; {} allowed
  requestContext: {
    authorizer: Record<string, unknown>; // observed always {}
    http: {
      method: string; // GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD observed
      path: string; // quirky rebuild; NOT canonical
      sourceIp: string;
      userAgent: string;
    };
    requestId: string; // UUID v4
    time: string; // CLF, second precision
    timeEpoch: number; // SECONDS
    apiGateway?: {
      operationContext?: {
        probe?: { source: string; test: boolean; version: string };
      }; // probe presence outside console traffic [unknown]
    };
  };
  body: string; // "" allowed; plain iff CT==application/json else Base64
  isBase64Encoded: boolean; // TRUE for everything except application/json bodies
  pathParameters: Record<string, string>;
  parameters: Record<string, string>; // spec-declared only
  multiValueParameters: Record<string, string[]>; // spec-declared only
  operationId: string; // 64 hex
}

// Queue event — ONLY field: messages[]
interface QueueEvent {
  messages: QueueMessageEvent[];
}

interface QueueMessageEvent {
  event_metadata: {
    event_id: string; // 33-35 chars, pseudo-UUID; === details.message.message_id
    event_type: "yandex.cloud.events.messagequeue.QueueMessage";
    created_at: string; // ISO-8601 ms; == SentTimestamp epoch-ms
    tracing_context: null; // always null (observed)
    cloud_id: string; // 20 chars
    folder_id: string; // 20 chars
  };
  details: {
    queue_id: string; // "yrn:yc:ymq:<region>:<folderId>:<queueName>"  [format inferred]
    message: {
      message_id: string;
      md5_of_body: string; // 32 hex over UTF-8 bytes of body
      body: string; // raw UTF-8; NEVER base64; no flag exists
      attributes: {
        ApproximateFirstReceiveTimestamp: string; // epoch-ms string
        ApproximateReceiveCount: string;
        SenderId: string;
        SentTimestamp: string; // epoch-ms string
      };
      message_attributes: Record<
        string,
        {
          data_type: string; // "String" | "Number" observed
          string_value: string;
        }
      >; // {} common
      md5_of_message_attributes: string; // "" when no attrs, else 32 hex
    };
  };
}

// Context — identical shape in both modes
interface FunctionContext {
  awsRequestId: string; // UUID v4; === requestId; === filename uuid
  requestId: string; // duplicate of awsRequestId
  invokedFunctionArn: string; // BARE id, not arn:// ; === functionName
  functionName: string;
  functionVersion: string;
  functionFolderId: string; // 20 chars
  memoryLimitInMB: string; // STRING, e.g. "1024"
  deadlineMs: number; // absolute epoch ms; ~timestamp + timeout
  logGroupName: string; // observed always ""
  token: string; // IAM token; REDACTED in dumps — handle as secret
  uberTraceId: string; // "<trace>:<span>:<parent>:1", 16 hex each
  _data: HttpEventV2 | QueueEvent; // exact deep copy of event (internal)
}
```

---

## REFERENCE_FOR_AI

```yaml
dataset: 97 valid JSON dumps; 46 HTTP(API-Gateway v2-style) + 51 Yandex Message Queue;
         node v22.15.0; one function; Aug 2026.

top_level: { timestamp: str(ISO-ms), node: str, event: obj, context: obj }   # exact, no extra keys

http_event:  # all fields below ALWAYS present (46/46)
  version: "2.0"                                   # constant
  rawPath: str                                     # decoded, no query
  rawQueryString: str                              # "" allowed
  headers: map[str,str]                            # flat; NO arrays; 16 gateway headers always injected
    # Accept, Host, Traceparent, Tracestate(""), Uber-Trace-Id, User-Agent,
    # X-Api-Gateway-Function-Id, X-Envoy-External-Address, X-Envoy-Original-Path,
    # X-Forwarded-For, X-Forwarded-Proto, X-Real-Remote-Address(ip:port),
    # X-Request-Id(UUID=requestId), X-Serverless-Certificate-Ids("{}"),
    # X-Serverless-Gateway-Id, X-Trace-Id(UUID)
    # conditional client headers: Content-Type, Content-Length(str), Cookie(str),
    # Authorization, CORS *, custom X-*
  queryStringParameters: map[str,str]              # decoded; REPEATED PARAMS COMMA-JOINED
  requestContext:
    authorizer: {}                                 # always empty object
    http: { method: str, path: str(quirky; NOT canonical), sourceIp: str, userAgent: str }
    requestId: uuid                                # == X-Request-Id header
    time: str(CLF), timeEpoch: NUMBER(SECONDS!)
    apiGateway.operationContext.probe: { source:str, test:bool, version:str }
  body: str                                        # "" allowed; PLAIN iff CT==application/json else BASE64
  isBase64Encoded: bool                            # TRUE for everything except application/json bodies (incl. empty-body GET)
  pathParameters: map[str,str]                     # catch-all ID = full subpath ("" for "/"); %2F merges segments
  parameters: map[str,str]                         # ONLY spec-declared params; repeats -> LAST value
  multiValueParameters: map[str,str[]]             # same sources, full repeat lists
  operationId: str(64hex)
  # ABSENT: cookies object, multiValueHeaders, stage/domainName/pathPattern

queue_event:  # ONLY field: messages[]
  messages: [                                      # 1 element in ALL samples; max batch size UNKNOWN
    event_metadata: { event_id: str(33-35 pseudo-uuid),
                      event_type: "yandex.cloud.events.messagequeue.QueueMessage",
                      created_at: str(ISO-ms), tracing_context: NULL(always),
                      cloud_id: str20, folder_id: str20 }
    details:
      queue_id: "yrn:yc:ymq:ru-central1:<folderId>:<queueName>"
      message:
        message_id: str                            # === event_id
        md5_of_body: md5(UTF-8(body))
        body: str                                  # raw UTF-8, NEVER base64, no flag
        attributes: { ApproximateFirstReceiveTimestamp: str-ms, ApproximateReceiveCount: str,
                      SenderId: str, SentTimestamp: str-ms }   # all STRINGS
        message_attributes: { Name: { data_type: "String"|"Number", string_value: str } }  # {} common
        md5_of_message_attributes: str             # "" when no attrs, else 32hex
  ]

context:  # IDENTICAL shape in both modes
  awsRequestId == requestId == filename uuid (UUIDv4)
  functionName == invokedFunctionArn               # BARE 20-char id, NOT arn://
  functionVersion: str                             # changed between deployments
  functionFolderId: str20
  memoryLimitInMB: "1024"                          # STRING not number
  deadlineMs: number(epoch ms)                     # observed timestamp+~4.9s => 5s timeout [inferred]
  logGroupName: ""                                 # always empty string
  token: string                                    # IAM token, REDACTED in dumps — MUST be redacted
  uberTraceId: "trace:span:parent:1"(16hex each)   # trace matches HTTP Uber-Trace-Id header prefix
  _data: <exact deep copy of event>                # internal runtime duplicate, undocumented

behavior_notes:
  - repeated query params: comma-joined in queryStringParameters/parameters; arrays only in multiValueParameters
  - body base64 rule: application/json -> plain+false; EVERYTHING else (text, forms, binary,
    missing CT, empty) -> base64+true
  - form bodies NOT parsed; binary preserved losslessly via base64; unicode/emoji round-trip correctly
  - use rawPath+rawQueryString for routing; requestContext.http.path unreliable (trailing ?, reorder, '+' spaces)
  - encoded %3F can land INSIDE rawPath; %2F merges into pathParameters.ID
  - queue: created_at == SentTimestamp; receive delay observed 104-10482ms;
    ApproximateReceiveCount always "1" (no retries seen)
  - event_id === message_id (redundant)
  - tracing: HTTP has Traceparent+Uber-Trace-Id headers correlated with context.uberTraceId trace id;
    queue tracing_context is always null

redact: context.token, headers.Authorization, headers.Cookie,
        client IPs (sourceIp/X-Forwarded-For/X-Envoy-External-Address/X-Real-Remote-Address)

ambiguities: real token format [redacted]; max YMQ batch size [never >1 observed];
             whether probe block appears outside console/test traffic; duplicate-header-name collapsing
             (headers scalar; no multiValueHeaders); timeEpoch unit elsewhere [always seconds here].
```

---

## MAPPING TO AGENTS.md FACTS

| AGENTS.md claim                           | Status after this analysis                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| §4.1 HTTP event shape                     | confirmed; `apiGateway.operationContext.probe` observed deeper than sketched; all listed fields always present              |
| §4.2 canonical `rawPath`/`rawQueryString` | confirmed with concrete counter-examples against `requestContext.http.path` (§E3)                                           |
| §4.3 repeated parameters                  | confirmed; comma-join + last-wins in `parameters` documented (§E2)                                                          |
| §4.4 body encoding rule                   | confirmed across text/form/binary/custom/missing CT/empty bodies; `custom+json` also Base64 (§E1)                           |
| §4.5 headers flat map                     | confirmed; 16 always-present injected headers enumerated (§B2)                                                              |
| §4.6 Queue event shape                    | confirmed; `tracing_context` typed as `null` in practice; batching never >1 observed                                        |
| §5 Context model                          | confirmed; adds: `requestId` duplicates `awsRequestId`; `invokedFunctionArn` is bare id; `_data` deep-equals event in 97/97 |
