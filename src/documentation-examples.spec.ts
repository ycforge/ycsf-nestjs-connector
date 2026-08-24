import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from "@nestjs/common";
import {
  ConnectorError,
  QueueHandler,
  QueueMessage,
  YandexContext,
  createYandexHandler,
  safeDiagnostics,
} from "./index";
import type { ClosableYandexCloudFunctionHandler } from "./index";
import type { YandexExecutionContext } from "./index";

/**
 * Contract coverage for the README usage examples (issue #16).
 *
 * The mirrors below restate every critical README snippet against the public
 * barrel only, so documentation cannot drift from the real API: a renamed
 * export, changed generic, removed option field or reshaped normalized model
 * fails here even when no runtime behavior changed. Decorators are applied
 * imperatively because this repository compiles without
 * experimentalDecorators/emitDecoratorMetadata; the imperative form is exactly
 * what user projects execute at runtime after desugaring. README fences are
 * additionally kept syntactically valid via a lightweight parse check instead
 * of fragile content matching.
 */

const repoRoot = path.join(__dirname, "..");

function methodDescriptor(target: object, propertyKey: string): TypedPropertyDescriptor<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  if (!descriptor) {
    throw new Error(`missing property descriptor for ${String(propertyKey)}`);
  }
  return descriptor;
}

// ---------------------------------------------------------------------------
// Mirror: "Minimal HTTP function" — controller, module, bootstrap.
// ---------------------------------------------------------------------------

class OrdersController {
  find(id: string, expand?: string): object {
    return { id, expand };
  }

  create(body: unknown): object {
    return { received: body };
  }
}

Controller("orders")(OrdersController);
Get(":id")(
  OrdersController.prototype,
  "find",
  methodDescriptor(OrdersController.prototype, "find"),
);
Param("id")(OrdersController.prototype, "find", 0);
Query("expand")(OrdersController.prototype, "find", 1);
Post()(
  OrdersController.prototype,
  "create",
  methodDescriptor(OrdersController.prototype, "create"),
);
Body()(OrdersController.prototype, "create", 0);

class AppModule {}
Module({ controllers: [OrdersController] })(AppModule);

// ---------------------------------------------------------------------------
// Mirror: "Execution context" + "Message Queue consumers".
// ---------------------------------------------------------------------------

/** Field reads stay type-checked exactly as the README documents them. */
function summarizeContext(executionContext: YandexExecutionContext): Record<string, unknown> {
  const memoryLimitInMB: string = executionContext.memoryLimitInMB;
  return {
    invocationId: executionContext.awsRequestId,
    functionName: executionContext.functionName,
    functionVersion: executionContext.functionVersion,
    functionFolderId: executionContext.functionFolderId,
    memoryLimitInMB,
    deadlineMs: executionContext.deadlineMs,
    logGroupName: executionContext.logGroupName,
    uberTraceId: executionContext.uberTraceId,
    rawEventKind: typeof executionContext.rawEvent,
    rawKind: typeof executionContext.raw,
  };
}

interface OrderEvent {
  orderId: string;
}

class OrdersConsumer {
  handle(message: QueueMessage<OrderEvent>, executionContext: YandexExecutionContext): void {
    this.processOrder(message.payload);
    this.auditDelivery(
      executionContext.awsRequestId,
      message.messageId,
      message.md5OfBody,
      message.body,
    );
  }

  private processOrder(order: OrderEvent): void {
    if (order.orderId.length === 0) {
      throw new Error("empty order id");
    }
  }

  /** Raw body access stays available beside the typed payload (README claim). */
  private auditDelivery(
    invocationId: string,
    messageId: string,
    md5OfBody: string,
    rawBody: string,
  ): string {
    return `${invocationId}/${messageId}/${md5OfBody}:${rawBody.length}`;
  }

  /** Normalized model names the README documents must all resolve. */
  normalizedView(message: QueueMessage): Record<string, unknown> {
    const firstAttributeName = Object.keys(message.messageAttributes)[0];
    return {
      messageId: message.messageId,
      md5OfBody: message.md5OfBody,
      rawBodyLength: message.body.length,
      firstAttributeType:
        firstAttributeName === undefined
          ? null
          : (message.messageAttributes[firstAttributeName]?.dataType ?? null),
      md5OfMessageAttributes: message.md5OfMessageAttributes,
      queueId: message.queueId,
      eventId: message.eventMetadata.eventId,
      createdAt: message.eventMetadata.createdAt,
      systemAttribute: message.attributes["ApproximateReceiveCount"],
      rawKind: typeof message.raw,
    };
  }
}

Injectable()(OrdersConsumer);
QueueHandler()(
  OrdersConsumer.prototype,
  "handle",
  methodDescriptor(OrdersConsumer.prototype, "handle"),
);
QueueMessage()(OrdersConsumer.prototype, "handle", 0);
YandexContext()(OrdersConsumer.prototype, "handle", 1);

describe("README example mirrors (public API contract)", () => {
  it("keeps the documented execution context fields and types resolvable", () => {
    // Structural compile check against the exported YandexExecutionContext:
    // every field the README lists must exist with the documented type
    // (memoryLimitInMB stays string, deadlineMs stays epoch milliseconds).
    const summary = summarizeContext({
      awsRequestId: "req-docs-smoke",
      functionName: "fn-docs-smoke",
      functionVersion: "$LATEST",
      functionFolderId: "folder-docs-smoke",
      memoryLimitInMB: "1024",
      deadlineMs: 1787328996791,
      logGroupName: "",
      rawEvent: { version: "2.0" },
      raw: {},
      toJSON: () => ({}),
    });

    expect(summary.invocationId).toBe("req-docs-smoke");
    expect(summary.memoryLimitInMB).toBe("1024");
  });

  it("bootstraps the documented handler and exposes the closable contract", async () => {
    const handler: ClosableYandexCloudFunctionHandler = createYandexHandler(AppModule);

    // Events nobody claims fail fast at detection — before any Nest cold start
    // (README "How it works" bullet) — with the documented stable code.
    const failure: unknown = await handler({}, {}).then(
      () => {
        throw new Error("unknown event must reject");
      },
      (error: unknown) => error,
    );
    if (!(failure instanceof ConnectorError)) {
      throw new Error(`expected ConnectorError, got ${String(failure)}`);
    }
    expect(failure.code).toBe("UNKNOWN_INVOCATION_EVENT");

    // close(): idempotent and safe around invocations (README shutdown text).
    await expect(handler.close()).resolves.toBeUndefined();
    await expect(handler.close()).resolves.toBeUndefined();
  });

  it("accepts the documented custom queue body deserializer option", async () => {
    const handler: ClosableYandexCloudFunctionHandler = createYandexHandler(AppModule, {
      queue: {
        // Mirrors the README custom deserializer; both documented parameters
        // are part of the public QueueBodyDeserializer contract.
        deserializeBody: (body, message) => (message.queueId.length > 0 ? JSON.parse(body) : body),
      },
    });

    await expect(handler.close()).resolves.toBeUndefined();
  });

  it("keeps the documented safeDiagnostics redaction claim true", () => {
    const redacted: { context: { token: string } } = JSON.parse(
      JSON.stringify(
        safeDiagnostics({
          stage: "handled",
          context: {
            awsRequestId: "req-1",
            functionName: "fn-docs-smoke",
            functionVersion: "$LATEST",
            memoryLimitInMB: "1024",
            token: "iam-secret",
          },
        }),
      ),
    );

    expect(redacted.context.token).toBe("REDACTED_TOKEN");
  });
});

describe("README source hygiene", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

  it("documents installation through the actual package name", () => {
    expect(readme).toContain("npm install @ycforge/ycsf-nestjs-connector");
  });

  it("imports snippets only through the public package entry point", () => {
    expect(readme).toContain('from "@ycforge/ycsf-nestjs-connector"');
  });

  it("keeps every TypeScript snippet syntactically valid", () => {
    const fences = [...readme.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(fences.length).toBeGreaterThanOrEqual(6);

    for (const fence of fences) {
      const { diagnostics } = ts.transpileModule(fence ?? "", {
        compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
        reportDiagnostics: true,
      });
      const messages = (diagnostics ?? []).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      );
      expect(messages).toEqual([]);
    }
  });
});
