import { All, Controller, Module } from "@nestjs/common";
import {
  resolveInvocationExecutionContext,
  resolveInvocationHttpRequest,
} from "../context/invocation-scope";
import { QueueHandler } from "../mq/queue-handler.decorator";
// Merged export: decorator factory plus the normalized message type it injects.
import { QueueMessage } from "../mq/queue-message.decorator";

/**
 * Built-in replay application for the local fixture replay CLI (issue #12,
 * development tooling — NOT part of the published package).
 *
 * One NestJS module serves both transports exactly like a deployed function
 * would: an HTTP catch-all controller answers every committed HTTP fixture
 * path, and one `@QueueHandler()` consumes every delivered Message Queue
 * message. Decorators are applied imperatively (legacy desugaring shape) so
 * the module stays independent of decorator compilation settings, mirroring
 * the conformance suites.
 *
 * The controller response is deliberately VALUE-FREE (AGENTS.md section 6.2):
 * it echoes structural facts only — method, path, correlation id, query
 * parameter NAMES, header count, body size. Fixture values such as headers,
 * cookies or bodies are never echoed back into tool output.
 */

class ReplayProbeController {
  probe(): Record<string, unknown> {
    const request = resolveInvocationHttpRequest();
    const executionContext = resolveInvocationExecutionContext();
    return {
      method: request.method,
      path: request.path,
      requestId: executionContext.awsRequestId,
      queryParameterNames: Object.keys(request.queryStringParameters).sort(),
      headerCount: Object.keys(request.headers).length,
      bodyBytes: request.body?.byteLength ?? 0,
    };
  }
}

Controller()(ReplayProbeController);

const probeDescriptor = Object.getOwnPropertyDescriptor(ReplayProbeController.prototype, "probe");
if (!probeDescriptor) {
  throw new Error("missing descriptor for ReplayProbeController.probe");
}
All("*rest")(ReplayProbeController.prototype, "probe", probeDescriptor);

class ReplayQueueConsumer {
  consume(message: QueueMessage): void {
    // Bodies stay opaque here on purpose: the default strict-JSON payload
    // policy must not fail deliveries whose handlers never decode them
    // (issue #9 semantics), so the consumer touches nothing but identity.
    void message;
  }
}

QueueHandler()(
  ReplayQueueConsumer.prototype,
  "consume",
  Object.getOwnPropertyDescriptor(ReplayQueueConsumer.prototype, "consume")!,
);
QueueMessage()(ReplayQueueConsumer.prototype, "consume", 0);

export class ReplayAppModule {}

Module({
  controllers: [ReplayProbeController],
  providers: [ReplayQueueConsumer],
})(ReplayAppModule);
