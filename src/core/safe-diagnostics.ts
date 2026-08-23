import { ConnectorError } from "./connector-error";

/**
 * The explicit boundary between raw invocation data and safe diagnostics
 * (issue #13, AGENTS.md section 6.2).
 *
 * Three representations exist and must never be conflated:
 *
 * 1. **Raw** — `raw`/`rawEvent` escape hatches and direct property access.
 *    Exact runtime references, intentionally unsafe: they carry the IAM
 *    token, client credentials and unredacted personal data. Never mutated
 *    by this module; never logged by connector code.
 * 2. **Safe diagnostics** — derived, redacted copies produced by
 *    {@link safeDiagnostics} for logs, tests and debugging. Deterministic,
 *    non-mutating and JSON-safe by construction.
 * 3. **Replay CLI output** — even stricter value-free rendering owned by
 *    src/testing/replay-cli.ts (fixed error categories only). This module
 *    deliberately shares no error-rendering logic with it.
 *
 * Redaction policy of {@link safeDiagnostics}, in force for every nesting
 * level of the serialized structure:
 *
 * - `token` — replaced with {@link REDACTED_TOKEN} **on the root object**
 *   of the serialized value (the execution-context shape) and on any nested
 *   node matching the runtime-context fingerprint (own `awsRequestId` +
 *   `functionName` + `functionVersion` + `memoryLimitInMB`, plus a
 *   string-typed own `token` — all four identity fields are mandatory on
 *   every context the builder accepts, DATA-ANALYSE.md section D), so
 *   realistic diagnostic wrappers such as `{ message: "...", ctx: context }`
 *   never leak the IAM secret. Other nested `token` properties are preserved
 *   verbatim: application payloads may legitimately carry domain fields named
 *   `token`, and blindly redacting them would destroy business data. Explicit
 *   boundary: a lookalike telemetry object matching only PART of that field
 *   set keeps its token — partial matches are guesswork, not recognition.
 * - Inside any property named exactly `headers`, entry names are matched
 *   case-insensitively against the observed sensitive set:
 *   `Authorization` → {@link REDACTED_AUTHORIZATION}, `Cookie` →
 *   {@link REDACTED_COOKIE}, `X-Forwarded-For`, `X-Envoy-External-Address`,
 *   `X-Real-Remote-Address` → {@link REDACTED_IP}. Names outside that map are
 *   untouched — notably the correlation identifiers (`X-Request-Id`,
 *   `X-Trace-Id`, `Uber-Trace-Id`, `Traceparent`), which DATA-ANALYSE.md
 *   section H classifies as low-sensitivity and observability needs
 *   (AGENTS.md section 33).
 * - `sourceIp` at any depth → {@link REDACTED_IP} (observed client IP field).
 * - Keys `raw`/`rawEvent` are omitted entirely: raw escape hatches never
 *   enter safe diagnostics; read them explicitly when you actually need them.
 * - Recognized payload carriers drop their bodies instead of dumping them:
 *   a normalized queue message serializes to identity/metadata plus attribute
 *   NAMES — body, lazy `payload` and attribute string values are omitted
 *   because queue payloads routinely contain application secrets; a raw API
 *   Gateway v2 event and a raw MQ wire message omit their `body` key.
 *
 *   Recognition is deliberately strict (false-positive audit): each wire
 *   fingerprint demands the COMPLETE top-level field set its transport's
 *   structural validator requires — fields delivered in 46/46 (HTTP) and
 *   51/51 (MQ) captured invocations — so ordinary business objects owning a
 *   plausible subset (`body`, `token`, `messageId`, `version: "2.0"`,
 *   `rawPath`, …) are NOT matched and stay intact. The normalized message
 *   additionally requires `payload` to be a lazy own accessor, which every
 *   genuine message has and application lookalikes do not.
 *
 *   Documented trade-off: an INCOMPLETE carrier (a hand-trimmed event or
 *   partial wire message missing one required field) falls back to generic
 *   traversal and its body WOULD render. When uncertain, serialize complete
 *   observed events or normalized models — or pass the payload-bearing part
 *   through a deliberate redaction of your own.
 *
 *   Two credential-bearing duplication channels are reduced wherever their
 *   structural names appear: raw wire message attributes render as
 *   name → declared `dataType` only (scoped to the recognized raw MQ wire
 *   message), and gateway-declared parameter maps (`parameters`,
 *   `queryStringParameters`, `multiValueParameters` — observed on raw events
 *   and normalized requests alike, DATA-ANALYSE.md anomaly 10) get
 *   placeholders for entries named like credentials (`authorization` exactly,
 *   or any name containing "cookie") while all other entries pass through
 *   verbatim.
 * - `Error` instances (including `ConnectorError`) collapse to
 *   `{ name }` plus `{ code, transportId }` for boundary errors. `message`,
 *   `stack` and `cause` are never emitted: arbitrary exception text may
 *   quote request data.
 * - Accessor properties are never evaluated (descriptor check): traversal
 *   cannot execute getters, so lazy memoized values such as
 *   `QueueMessage.payload` are neither computed nor leaked; they render as
 *   `[unevaluated getter]`.
 * - Dates become ISO strings, binary views/buffers become
 *   `[binary value: N bytes]`, bigints become decimal strings, functions/
 *   symbols/undefined-valued properties are dropped, cycles render as
 *   `[circular]` — keeping the output stable under `JSON.stringify`.
 *
 * Non-goals: this is not a security framework, it does not parse query
 * strings (pass them through `rawQueryString` at your own discretion), does
 * not traverse proxies predictably (traps may run — serialize plain data),
 * and does not mutate its input anywhere.
 */

/** Placeholder substituted for the service account IAM token. */
export const REDACTED_TOKEN = "REDACTED_TOKEN";

/** Placeholder substituted for `Authorization` header values. */
export const REDACTED_AUTHORIZATION = "REDACTED_AUTHORIZATION";

/** Placeholder substituted for `Cookie` header values. */
export const REDACTED_COOKIE = "REDACTED_COOKIE";

/** Placeholder substituted for client IP fields and IP-bearing headers. */
export const REDACTED_IP = "REDACTED_IP";

/** Rendered for accessor properties instead of invoking the getter. */
const UNEVALUATED_GETTER = "[unevaluated getter]";

/** Rendered when a structure revisits one of its own ancestors. */
const CIRCULAR = "[circular]";

/**
 * Sensitive header names (lowercase) mapped to their placeholders. Scope:
 * exactly the credential/client-IP headers of the observed dataset
 * (DATA-ANALYSE.md section H). Correlation identifiers are deliberately
 * absent — see the module documentation.
 */
const SENSITIVE_HEADER_PLACEHOLDERS: Readonly<Record<string, string>> = {
  authorization: REDACTED_AUTHORIZATION,
  cookie: REDACTED_COOKIE,
  "x-forwarded-for": REDACTED_IP,
  "x-envoy-external-address": REDACTED_IP,
  "x-real-remote-address": REDACTED_IP,
};

/** Fingerprint fields identifying a normalized queue message envelope. */
const QUEUE_MESSAGE_FINGERPRINT = [
  "messageId",
  "md5OfBody",
  "body",
  "attributes",
  "messageAttributes",
  "md5OfMessageAttributes",
  "queueId",
  "eventMetadata",
] as const;

/**
 * Transforms an arbitrary diagnostic value into its redacted, JSON-safe
 * representation. Pure: the input is never mutated, plain output structures
 * are freshly built every call, and repeated calls on identical inputs yield
 * deep-equal results.
 *
 * Intended for logging and test assertions around raw Yandex events, the
 * normalized models, boundary failures and mixed diagnostic objects. Raw
 * access stays available through the documented `raw`/`rawEvent` escape
 * hatches — which this function intentionally refuses to follow.
 */
export function safeDiagnostics(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), { isRoot: true });
}

interface WalkFrame {
  /** True only for the object passed directly to {@link safeDiagnostics}. */
  readonly isRoot: boolean;
}

function redactValue(value: unknown, seen: WeakSet<object>, frame: WalkFrame): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    // JSON.stringify throws on bigint; the decimal string keeps the result
    // safely serializable without pretending the type was preserved.
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const binaryBytes = binaryByteLength(value);
  if (binaryBytes !== undefined) {
    return `[binary value: ${binaryBytes} bytes]`;
  }

  if (value instanceof Error) {
    return redactError(value);
  }

  if (Array.isArray(value)) {
    return redactArray(value, seen);
  }

  const record = value as Record<string, unknown>;

  // A node shaped like the observed runtime context carries the IAM token
  // regardless of how deeply it is nested inside a diagnostic envelope, so
  // realistic wrappers such as `{ message: "...", ctx: context }` stay safe.
  // The fingerprint demands fields that are MANDATORY on every context the
  // builder accepts and were observed identically across all captured
  // invocations (DATA-ANALYSE.md section D); application telemetry that
  // merely pairs a request id, a function name and a token stays untouched.
  const contextShaped = !frame.isRoot && isRuntimeContextShape(record);

  if (isQueueMessageShape(record)) {
    return redactQueueMessage(record, seen);
  }

  // Every remaining non-array object is traversed as an open record of its
  // own enumerable string-keyed data properties: raw Yandex events arrive as
  // plain JSON structures and the normalized models are frozen literals, so
  // own-property enumeration is this module's documented traversal contract.
  // Proxy inputs are out of contract (traps may run; see module docs).
  const scope = rawWireScope(record);
  const omitKeys = scope === undefined ? EMPTY_OMIT_KEYS : RAW_PAYLOAD_OMIT_KEYS;
  return redactRecord(record, seen, contextShaped ? ROOT_FRAME : frame, omitKeys, scope);
}

const EMPTY_OMIT_KEYS: ReadonlySet<string> = new Set<string>();
const RAW_PAYLOAD_OMIT_KEYS: ReadonlySet<string> = new Set(["body"]);
const ROOT_FRAME: WalkFrame = { isRoot: true };

function redactArray(source: readonly unknown[], seen: WeakSet<object>): unknown[] {
  return visitNode(source, seen, () =>
    source.map((element) => {
      const redacted = redactValue(element, seen, { isRoot: false });
      // Array slots stay positional: dropped values become null like
      // JSON.stringify would produce.
      return redacted === undefined ? null : redacted;
    }),
  );
}

/**
 * Walks one record-shaped node. Only own enumerable string keys participate;
 * accessor properties are flagged instead of invoked, so traversal can never
 * execute application code or surface lazily computed values.
 */
function redactRecord(
  source: Record<string, unknown>,
  seen: WeakSet<object>,
  frame: WalkFrame,
  omitKeys: ReadonlySet<string>,
  wireScope: RawWireScope | undefined = undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  return visitNode(source, seen, () => {
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor) {
        continue;
      }
      if (descriptor.get !== undefined) {
        result[key] = UNEVALUATED_GETTER;
        continue;
      }
      const propertyValue = descriptor.value;
      if (
        propertyValue === undefined ||
        typeof propertyValue === "function" ||
        typeof propertyValue === "symbol"
      ) {
        continue;
      }

      // Raw escape hatches stay out of diagnostics by construction; the
      // exact references remain available through direct property access.
      if (key === "raw" || key === "rawEvent" || omitKeys.has(key)) {
        continue;
      }
      // Documented scope: only the ROOT object's token is the runtime IAM
      // secret; nested tokens belong to application payloads.
      if (frame.isRoot && key === "token") {
        result[key] = REDACTED_TOKEN;
        continue;
      }
      // Observed structural field name of the gateway client IP; specific
      // enough to match at any depth without touching business data.
      if (key === "sourceIp") {
        result[key] = REDACTED_IP;
        continue;
      }
      if (key === "headers") {
        result[key] = redactHeadersMap(propertyValue, seen);
        continue;
      }
      // Gateway-declared parameter maps duplicate cookie/header values under
      // their declared names (observed on raw events and normalized
      // requests alike), so they are sanitized wherever encountered.
      if (
        key === "parameters" ||
        key === "queryStringParameters" ||
        key === "multiValueParameters"
      ) {
        result[key] = redactGatewayParameterMap(propertyValue, seen);
        continue;
      }
      if (wireScope !== undefined) {
        const scoped = redactScopedRawProperty(wireScope, key, propertyValue, seen);
        if (scoped.handled) {
          result[key] = scoped.value;
          continue;
        }
      }
      result[key] = redactValue(propertyValue, seen, { isRoot: false });
    }
    return result;
  });
}

/**
 * Applies the sensitive-header policy to one `headers` map. Entry names are
 * case-insensitive (the gateway Pascal-Cases them, but clients control what
 * arrives); non-sensitive entries recurse through ordinary value handling.
 */
function redactHeadersMap(headersValue: unknown, seen: WeakSet<object>): unknown {
  if (!isRecordLike(headersValue)) {
    return redactValue(headersValue, seen, { isRoot: false });
  }
  const source = headersValue;
  return visitNode(source, seen, () => {
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (!descriptor) {
        continue;
      }
      if (descriptor.get !== undefined) {
        result[name] = UNEVALUATED_GETTER;
        continue;
      }
      const placeholder = SENSITIVE_HEADER_PLACEHOLDERS[name.toLowerCase()];
      if (placeholder !== undefined && descriptor.value !== undefined) {
        result[name] = placeholder;
        continue;
      }
      result[name] = redactValue(descriptor.value, seen, { isRoot: false });
    }
    return result;
  });
}

/**
 * Purpose-built view over a recognized normalized queue message: identity,
 * checksums, system attributes, delivery metadata and user attribute NAMES —
 * but no body, no deserialized payload and no attribute string values, all
 * of which routinely carry application secrets.
 */
function redactQueueMessage(
  message: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  return visitNode(message, seen, () => ({
    messageId: message["messageId"],
    md5OfBody: message["md5OfBody"],
    md5OfMessageAttributes: message["md5OfMessageAttributes"],
    queueId: message["queueId"],
    attributes: redactValue(message["attributes"], seen, { isRoot: false }),
    eventMetadata: redactValue(message["eventMetadata"], seen, { isRoot: false }),
    messageAttributeNames: messageAttributeNames(message["messageAttributes"]),
  }));
}

function messageAttributeNames(messageAttributes: unknown): string[] {
  if (!isRecordLike(messageAttributes)) {
    return [];
  }
  return Object.keys(messageAttributes);
}

/**
 * Payload-carrier fingerprints of the raw wire shapes. Both are local to the
 * carrying node, so additive wrapper fields keep flowing through the generic
 * walk unchanged.
 */
type RawWireScope = "http-api-gateway-v2" | "message-queue-message";

/**
 * Own-presence requirements for recognizing a raw API Gateway v2 event:
 * exactly the top-level field set the HTTP transport's structural validator
 * demands (src/http/validate-raw-event.ts), all of which were delivered in
 * 46/46 captured invocations (DATA-ANALYSE.md section B). Requiring the FULL
 * observed set keeps genuine events recognized while making accidental
 * collisions with application objects implausible — an object missing any
 * single field is treated as ordinary data whose properties render verbatim.
 */
const RAW_HTTP_EVENT_REQUIRED_KEYS = [
  "rawPath",
  "rawQueryString",
  "headers",
  "queryStringParameters",
  "requestContext",
  "body",
  "isBase64Encoded",
  "pathParameters",
  "parameters",
  "multiValueParameters",
  "operationId",
] as const;

/**
 * Own-presence requirements for recognizing a raw Message Queue wire message:
 * the complete snake_case field set the MQ validator requires
 * (src/mq/validate-raw-event.ts), each present in 51/51 captures. The earlier
 * two-field version (`message_id` + `md5_of_body`) was too loose: a domain
 * record carrying just those names would have lost its `body` and had its
 * `message_attributes` values reduced to type declarations.
 */
const RAW_QUEUE_MESSAGE_REQUIRED_KEYS = [
  "message_id",
  "md5_of_body",
  "body",
  "attributes",
  "message_attributes",
  "md5_of_message_attributes",
] as const;

function rawWireScope(value: Record<string, unknown>): RawWireScope | undefined {
  if (
    value["version"] === "2.0" &&
    RAW_HTTP_EVENT_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    return "http-api-gateway-v2";
  }
  if (RAW_QUEUE_MESSAGE_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))) {
    return "message-queue-message";
  }
  return undefined;
}

/**
 * Minimum co-occurrence marking a NESTED node as a runtime execution context.
 * `awsRequestId`, `functionName`, `functionVersion` and `memoryLimitInMB` are
 * mandatory on every context `buildYandexExecutionContext` accepts and were
 * observed identically in 97/97 captured invocations; requiring them beside a
 * string-typed `token` keeps realistic diagnostic wrappers safe while leaving
 * application objects that happen to own a token (or even a request-id/
 * function-name pair) verbatim. Deliberate trade-off: a lookalike telemetry
 * object matching only PART of this set keeps its token — when a structure is
 * not recognizably a runtime context, redacting it would be guesswork.
 */
function isRuntimeContextShape(record: Record<string, unknown>): boolean {
  return (
    ["awsRequestId", "functionName", "functionVersion", "memoryLimitInMB"].every((key) =>
      Object.hasOwn(record, key),
    ) && typeof record["token"] === "string"
  );
}

/**
 * Scoped suppression rules inside a recognized raw wire node: the payload
 * itself is always dropped, and structurally known duplication channels of
 * credential-bearing data are reduced to their identifying parts (observed:
 * user message attributes carry free-form string values).
 */
function redactScopedRawProperty(
  scope: RawWireScope,
  key: string,
  propertyValue: unknown,
  seen: WeakSet<object>,
): { handled: false } | { handled: true; value: unknown } {
  if (scope === "message-queue-message" && key === "message_attributes") {
    return { handled: true, value: redactRawMessageAttributes(propertyValue, seen) };
  }
  return { handled: false };
}

/**
 * Renders raw wire message attributes as attribute NAME -> declared data
 * type. The free-form `string_value` is treated as potentially sensitive
 * application data and never rendered.
 */
function redactRawMessageAttributes(
  messageAttributes: unknown,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (!isRecordLike(messageAttributes)) {
    return {};
  }
  const source = messageAttributes;
  return visitNode(source, seen, () => {
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (!descriptor) {
        continue;
      }
      if (descriptor.get !== undefined) {
        result[name] = UNEVALUATED_GETTER;
        continue;
      }
      const declaration = descriptor.value;
      result[name] =
        isRecordLike(declaration) && typeof declaration["data_type"] === "string"
          ? { dataType: declaration["data_type"] }
          : "[unrecognized attribute declaration]";
    }
    return result;
  });
}

/**
 * Sanitizes gateway-declared parameter maps (`parameters`,
 * `queryStringParameters`, `multiValueParameters`). Observed behavior
 * (DATA-ANALYSE.md anomaly 10): these maps duplicate spec-declared cookies
 * and headers under their declared names — both on raw events and on the
 * normalized request — so wherever such a map appears, entries named like
 * credentials get placeholders while everything else recurses through
 * ordinary handling. Value representations are preserved: multi-value
 * entries stay arrays of placeholders.
 */
function redactGatewayParameterMap(parameterValue: unknown, seen: WeakSet<object>): unknown {
  if (!isRecordLike(parameterValue)) {
    return redactValue(parameterValue, seen, { isRoot: false });
  }
  const source = parameterValue;
  return visitNode(source, seen, () => {
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (!descriptor) {
        continue;
      }
      if (descriptor.get !== undefined) {
        result[name] = UNEVALUATED_GETTER;
        continue;
      }
      const lowered = name.toLowerCase();
      const placeholder = lowered.includes("cookie")
        ? REDACTED_COOKIE
        : lowered === "authorization"
          ? REDACTED_AUTHORIZATION
          : undefined;
      if (placeholder !== undefined) {
        // multiValueParameters entries are arrays: keep that representation
        // (AGENTS.md section 4.3 — never merge the two param views).
        const original = descriptor.value;
        result[name] = Array.isArray(original) ? original.map(() => placeholder) : placeholder;
        continue;
      }
      result[name] = redactValue(descriptor.value, seen, { isRoot: false });
    }
    return result;
  });
}

/**
 * Recognizes a normalized queue message. The eight camelCase fields alone are
 * already a narrow conjunction, but the deciding discriminator is `payload`:
 * every genuine message defines it as a lazy own accessor
 * (src/mq/normalize-batch.ts), so an application lookalike that happens to
 * carry all eight names as ordinary data — including one holding a plain
 * `payload` value — is NOT matched and keeps its body/payload intact.
 */
function isQueueMessageShape(value: object): value is Record<string, unknown> {
  if (!QUEUE_MESSAGE_FINGERPRINT.every((key) => Object.hasOwn(value, key))) {
    return false;
  }
  const payload = Object.getOwnPropertyDescriptor(value, "payload");
  return payload !== undefined && payload.get !== undefined;
}

/**
 * Boundary errors expose their stable identifiers only. Application errors
 * reduce to the class name: messages, stacks and cause chains may quote
 * request data and are never traversed (AGENTS.md section 6.2).
 */
function redactError(error: Error): Record<string, unknown> {
  if (error instanceof ConnectorError) {
    return {
      name: error.name,
      code: error.code,
      ...(error.transportId === undefined ? null : { transportId: error.transportId }),
    };
  }
  return { name: error.name };
}

/**
 * Adds `node` to the ancestry while its subtree is produced, so reference
 * cycles terminate deterministically without mislabeling shared (diamond)
 * references as circular.
 */
function visitNode<T extends object, R>(node: T, seen: WeakSet<object>, produce: () => R): R {
  if (seen.has(node)) {
    // For arrays the caller maps elements itself; a direct array revisit
    // still lands here and renders the marker.
    return CIRCULAR as unknown as R;
  }
  seen.add(node);
  try {
    return produce();
  } finally {
    seen.delete(node);
  }
}

function binaryByteLength(value: object): number | undefined {
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  return undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
