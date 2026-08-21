/**
 * Contracts of the transport adapter SPI.
 *
 * A transport owns exactly one invocation shape (HTTP/API Gateway, Message
 * Queue, future triggers). Transports are independent from each other and are
 * detected/routed once by the core runtime (docs/ARCHITECTURE.md section 4).
 *
 * These declarations are intentionally type-only until issue #3 implements
 * the runtime that consumes them.
 */

/** Stable discriminator ids. Extending this union is the single registration point for a new transport. */
export type TransportId = "http" | "message-queue";

/**
 * Signature invoked by the Yandex Cloud Functions runtime.
 *
 * Parameters stay `unknown`: transports receive untrusted runtime payloads and
 * perform their own structural validation before narrowing.
 */
export type YandexCloudFunctionHandler = (
  rawEvent: unknown,
  rawContext: unknown,
) => Promise<unknown>;

/**
 * Token accepted by {@link InvocationContainer}.
 *
 * The constructor arm uses `never[]` arguments so both concrete and abstract
 * NestJS classes work as tokens without demanding a specific constructor
 * signature.
 */
export type InjectableToken<T = unknown> = (abstract new (...args: never[]) => T) | string | symbol;

/** Read-only provider resolution over the warm NestJS application instance. */
export interface InvocationContainer {
  resolve<T>(token: InjectableToken<T>): Promise<T>;
}

/** Per-invocation input handed to the transport that claimed an event. */
export interface TransportInvocation<TRawEvent = unknown> {
  /** Validated raw event, narrowed by {@link TransportAdapter.supports}. */
  readonly rawEvent: TRawEvent;
  /** Raw function context; opaque to the core, interpreted only where needed. */
  readonly rawContext: unknown;
  /** Access to the warm application container for handler resolution. */
  readonly container: InvocationContainer;
}

/**
 * A transport adapter claims and handles one invocation shape.
 *
 * `supports` must be cheap, deterministic, side-effect-free and must never
 * throw; deeper validation belongs to `invoke`, which reports failures as
 * `INVALID_INVOCATION_EVENT` (docs/ARCHITECTURE.md sections 4 and 6.3).
 */
export interface TransportAdapter<TRawEvent = unknown, TResult = unknown> {
  readonly id: TransportId;

  /** Structural claim check used once at the detection boundary. */
  supports(rawEvent: unknown): rawEvent is TRawEvent;

  /** Executes the transport-specific invocation semantics. */
  invoke(invocation: TransportInvocation<TRawEvent>): Promise<TResult>;
}
