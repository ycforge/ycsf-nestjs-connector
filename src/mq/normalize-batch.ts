import type {
  QueueBatch,
  QueueEventMetadata,
  QueueMessage,
  QueueMessageAttribute,
} from "./message";
import type {
  RawQueueEvent,
  RawQueueMessageAttributeValue,
  RawQueueMessageEvent,
} from "./raw-event";

/**
 * Transforms one validated raw Message Queue trigger event into the normalized
 * {@link QueueBatch} (issue #7).
 *
 * The rules encoded here are deliberate preservation decisions, not cleanup:
 *
 * - The delivery stays a batch: every element of `messages[]` becomes its own
 *   envelope and nothing assumes the current trigger's grouped-message limit
 *   of 1 (**observed**, AGENTS.md section 4.6).
 * - Values are kept in their observed forms: `createdAt` remains the ISO-8601
 *   string, `tracingContext` passes through verbatim (`null` in every capture),
 *   system attributes keep their string values — numeric-looking epochs stay
 *   strings ("Numbers-as-strings trap", DATA-ANALYSE.md sections B–C).
 * - `body` is copied by reference as the opaque transport-boundary payload;
 *   decoding or JSON parsing is a separate concern handled above this layer
 *   (AGENTS.md section 32; deserialization lands with issue #9).
 * - Checksums (`md5OfBody`, `md5OfMessageAttributes`) pass through verbatim;
 *   the connector never recomputes or verifies them.
 *
 * Normalization is transformation, not mutation: attribute maps are shared by
 * reference with the untouched event reachable through `raw`, so additive
 * Yandex fields survive without copying costs (AGENTS.md sections 7.3 and 36).
 */
export function normalizeQueueBatch(event: RawQueueEvent): QueueBatch {
  return Object.freeze({
    raw: event,
    messages: Object.freeze(event.messages.map(normalizeQueueMessage)),
  });
}

function normalizeQueueMessage(envelope: RawQueueMessageEvent): QueueMessage {
  const details = envelope.details;
  const message = details.message;
  const metadata = envelope.event_metadata;

  return Object.freeze({
    raw: envelope,

    // Observed identity fields pass through verbatim; event_id and message_id
    // were identical in 51/51 captures yet stay independent normalized fields
    // because they describe different objects (the delivery vs the message).
    messageId: message.message_id,
    md5OfBody: message.md5_of_body,
    body: message.body,
    attributes: message.attributes,
    messageAttributes: normalizeMessageAttributes(message.message_attributes),
    md5OfMessageAttributes: message.md5_of_message_attributes,

    queueId: details.queue_id,
    eventMetadata: Object.freeze({
      eventId: metadata.event_id,
      eventType: metadata.event_type,
      createdAt: metadata.created_at,
      tracingContext: metadata.tracing_context,
      cloudId: metadata.cloud_id,
      folderId: metadata.folder_id,
    }) satisfies QueueEventMetadata,
  });
}

/**
 * Maps the observed `data_type`/`string_value` entries to camelCase. Only
 * these two fields were captured; anything else on an entry keeps living on
 * the raw message instead of being copied or dropped.
 */
function normalizeMessageAttributes(
  source: Record<string, RawQueueMessageAttributeValue>,
): Readonly<Record<string, QueueMessageAttribute>> {
  const normalized: Record<string, QueueMessageAttribute> = {};
  for (const [name, value] of Object.entries(source)) {
    normalized[name] = { dataType: value.data_type, stringValue: value.string_value };
  }
  return Object.freeze(normalized);
}
