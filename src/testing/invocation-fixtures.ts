import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RawHttpApiGatewayV2Event } from "../http/raw-event";
import type { RawQueueEvent } from "../mq/raw-event";

/**
 * Test infrastructure (NOT part of the published package): loads the sanitized
 * conformance fixture dumps from `fixtures/` so specs can replay captured
 * Yandex invocations through the public connector API (issue #11).
 *
 * Fixture provenance, sanitization rules and evidence levels are documented in
 * `fixtures/README.md`.
 */

/** One sanitized warm-invocation dump exactly as stored on disk. */
export interface InvocationFixture<TEvent> {
  /** Capture time of the original invocation. */
  readonly timestamp: string;
  /** Node.js runtime version observed at capture time. */
  readonly node: string;
  /** Raw Yandex event, verbatim including undocumented additive fields. */
  readonly event: TEvent;
  /**
   * Raw Lambda-style runtime context, verbatim. Includes undocumented fields
   * such as `_data` (the runtime's deep copy of the event) and the redacted
   * service-account token placeholder.
   */
  readonly context: Record<string, unknown>;
}

export type HttpInvocationFixture = InvocationFixture<RawHttpApiGatewayV2Event>;
export type QueueInvocationFixture = InvocationFixture<RawQueueEvent>;

const FIXTURES_ROOT = path.join(__dirname, "..", "..", "fixtures");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readDump(subdirectory: string, name: string): Promise<Record<string, unknown>> {
  const filePath = path.join(FIXTURES_ROOT, subdirectory, `${name}.json`);
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isPlainObject(parsed)) {
    throw new Error(`Fixture ${filePath} must contain a single JSON object.`);
  }
  return parsed;
}

/**
 * Loads one HTTP/API Gateway v2 fixture by fixture name (file stem).
 *
 * Narrowing to {@link RawHttpApiGatewayV2Event} is repository-controlled test
 * data whose transport discriminator (`event.version === "2.0"`) is verified
 * here; full wire validation stays the adapter's job under replay.
 */
export async function loadHttpFixture(name: string): Promise<HttpInvocationFixture> {
  const dump = await readDump("http", name);
  const event = dump.event;
  if (!isPlainObject(event) || event.version !== "2.0") {
    throw new Error(`HTTP fixture "${name}" does not carry event.version "2.0".`);
  }
  return dump as unknown as InvocationFixture<RawHttpApiGatewayV2Event>;
}

/**
 * Loads one Message Queue trigger fixture by fixture name (file stem). The
 * `messages` array is verified because it is the queue transport's detection
 * discriminator; narrowing follows the same policy as {@link loadHttpFixture}.
 */
export async function loadQueueFixture(name: string): Promise<QueueInvocationFixture> {
  const dump = await readDump("mq", name);
  const event: unknown = dump.event;
  if (!isPlainObject(event) || !Array.isArray(event.messages)) {
    throw new Error(`Queue fixture "${name}" does not contain an event.messages array.`);
  }
  return dump as unknown as InvocationFixture<RawQueueEvent>;
}
