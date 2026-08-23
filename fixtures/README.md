# Conformance fixtures

Sanitized invocation dumps of real Yandex Cloud Functions traffic, used by the
conformance test suites in `src/http/conformance-fixtures.spec.ts` and
`src/mq/conformance-fixtures.spec.ts` to replay captured events through
`createYandexHandler()` without any Yandex Cloud connectivity (issue #11).

## Layout

```
fixtures/
  http/*.json   API Gateway payload format 2.0 invocations (46-capture evidence base)
  mq/*.json     Message Queue trigger invocations (51-capture evidence base)
```

Every file is a single warm-invocation dump:

```jsonc
{
  "timestamp": "2026-08-21T21:44:34.266Z", // capture time
  "node": "v22.15.0", // only runtime version observed in the dataset
  "event": {/* raw Yandex event, exactly as delivered */},
  "context": {
    /* raw Lambda-style context; "context"."_data" holds an undocumented deep
       copy of "event" - preserved verbatim because it is what the runtime emits */
  },
}
```

## Provenance and sanitization

The fixtures are distilled from the same sanitized capture archive that
[`../DATA-ANALYSE.md`](../DATA-ANALYSE.md) documents. The original archive is not
stored in this repository. Each fixture reproduces one recorded scenario with:

- IAM tokens replaced by `[REDACTED]` in `context.token` (the loader's JSON
  serialization re-redacts it as `REDACTED_TOKEN`);
- `Authorization`, `Cookie` and session values replaced by deterministic
  placeholders (`REDACTED_AUTHORIZATION`, `REDACTED_SESSION`);
- client IPs drawn from TEST-NET-3 (`203.0.113.0/24`);
- cloud/folder/queue identifiers replaced with synthetic constants matching the
  repository's established fixture convention (`a1b2c3d4000000000000`,
  `e5f6a7b8000000000000`);
- request IDs, trace IDs, operation IDs and message IDs derived
  deterministically from the fixture name.

Values that were observed to be constant or structurally significant are kept:
the injected gateway headers, the empty `authorizer {}` / `Tracestate ""` /
`logGroupName ""` trio, `X-Serverless-Certificate-Ids: "{}"`,
`apiGateway.operationContext` probe blocks, seconds-resolution `timeEpoch`,
string-typed `memoryLimitInMB`, `event_id === message_id`,
`created_at === SentTimestamp`, `tracing_context: null`.

## Evidence levels

Per [`../AGENTS.md`](../AGENTS.md) §2.3 each notable field falls into one of:

| Level       | Examples                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observed`  | all header names/values, body encoding rules, repeated-query comma joining, `rawPath` decoding of `%3F`, seconds `timeEpoch`, `_data` mirror, MQ attribute names/types |
| `inferred`  | ~5s timeout (`deadlineMs = event time + 4900`), SQS-compatible `md5_of_message_attributes` algorithm for user attributes                                               |
| `synthetic` | all identifiers listed above; exact timestamps within the capture window                                                                                               |

## Scenarios

HTTP (`fixtures/http/`):

| Fixture                           | Behavior pinned                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `get-without-query`               | bodiless GET still arrives `isBase64Encoded: true`; trailing `?` on rebuilt path                                                         |
| `catch-all-path-parameters`       | gateway-wide `ID` parameter carries the whole subpath                                                                                    |
| `repeated-query-parameters`       | comma join in `queryStringParameters`, list in `multiValueParameters`, alphabetical rebuild + trailing `?` on `requestContext.http.path` |
| `url-encoded-query-values`        | decoded query values incl. Unicode/emoji/reserved characters, lowercase percent hex on rebuild                                           |
| `encoded-path-characters`         | encoded `?` decodes into `rawPath`; routing must use `rawPath`/`rawQueryString`                                                          |
| `custom-headers-and-cookies`      | custom headers survive; declared cookie/header parameters exposed                                                                        |
| `json-body-plain-utf8`            | only `application/json` bodies arrive plain (`isBase64Encoded: false`)                                                                   |
| `plain-text-body-base64`          | other text types are Base64                                                                                                              |
| `form-body-base64`                | form bodies arrive Base64 and unparsed                                                                                                   |
| `binary-body-base64`              | binary survives round-trip byte-exactly                                                                                                  |
| `custom-json-content-type-base64` | suffix JSON types are NOT treated as plain JSON                                                                                          |

Message Queue (`fixtures/mq/`):

| Fixture                                   | Behavior pinned                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `simple-text-message`                     | opaque string body, system attributes, metadata relations                          |
| `json-body-message`                       | JSON body remains a string at the transport boundary; opt-in deserialization       |
| `unicode-body-message`                    | UTF-8 body + `md5_of_body` over UTF-8 bytes                                        |
| `custom-message-attributes`               | user message attributes with String/Number data types                              |
| `complete-metadata-and-system-attributes` | full event metadata block, `md5_of_message_attributes: ""` when no user attributes |

## Regenerating

The generator script that produced these files is intentionally not committed;
the JSON files themselves are the source of truth for tests. To adjust a value,
edit the JSON directly, keep it prettier-formatted (`npx prettier --check
fixtures`), and make sure the corresponding conformance test still documents why
the value matters.
