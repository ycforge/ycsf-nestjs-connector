import type { HasRaw } from "../core/raw-access";
import type { RawQueueEvent, RawQueueMessageEvent } from "./raw-event";

/**
 * Normalized Message Queue models. Application code consumes these; the raw
 * trigger payload remains reachable through {@link HasRaw}.
 */

/**
 * Metadata shared by all messages of one trigger delivery. Values are kept in
 * their observed forms — `createdAt` stays an ISO string and is not coerced to
 * a `Date`, `tracingContext` stays opaque.
 */
export interface QueueEventMetadata {
  readonly eventId: string;
  readonly eventType: string;
  readonly createdAt: string;
  readonly tracingContext: unknown;
  readonly cloudId: string;
  readonly folderId: string;
}

/**
 * Single message attribute with its declared data type, normalized to
 * camelCase from the observed `data_type`/`string_value` wire fields.
 */
export interface QueueMessageAttribute {
  readonly dataType: string;
  readonly stringValue: string;
}

/**
 * One queue message. `body` is opaque at the transport boundary — JSON or any
 * other decoding is a separate concern handled above the transport layer
 * (AGENTS.md section 32; deserialization lands with issue #9).
 */
export interface QueueMessage extends HasRaw<RawQueueMessageEvent> {
  readonly messageId: string;
  readonly md5OfBody: string;
  readonly body: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly messageAttributes: Readonly<Record<string, QueueMessageAttribute>>;
  readonly md5OfMessageAttributes: string;
  readonly queueId: string;
  readonly eventMetadata: QueueEventMetadata;
}

/**
 * A whole trigger delivery. Always modeled as a collection even though the
 * current trigger configuration delivers one message at a time (**observed**)
 * — the domain model must stay batch-capable (AGENTS.md section 4.6).
 */
export interface QueueBatch extends HasRaw<RawQueueEvent> {
  readonly messages: readonly QueueMessage[];
}
