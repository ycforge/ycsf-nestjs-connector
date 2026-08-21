/**
 * Normalized view over the Yandex Cloud Functions invocation context.
 *
 * Evidence level: **observed** field set documented in AGENTS.md section 5.
 * The full runtime context (including undocumented internals such as `_data`)
 * stays reachable through `raw`; nothing is coerced into more convenient types.
 */
export interface YandexExecutionContext {
  readonly awsRequestId: string;
  readonly functionName: string;
  readonly functionVersion: string;
  readonly functionFolderId: string;

  /**
   * Observed as a string on the real runtime. Deliberately NOT normalized to
   * a number; a numeric accessor may be added later as an explicit,
   * separately-named field without removing this one (AGENTS.md section 5).
   */
  readonly memoryLimitInMB: string;

  /** Absolute epoch milliseconds at which the invocation deadline passes. */
  readonly deadlineMs: number;

  readonly logGroupName: string;

  /**
   * Function service account IAM token. **Secret**: must never be logged or
   * embedded in diagnostics (AGENTS.md section 6.2). Optional because its
   * presence depends on the function's service account configuration;
   * optionality is **inferred**, not observed as absent in captures.
   */
  readonly token?: string;

  /** Trace propagation id injected by the platform when tracing is active. */
  readonly uberTraceId?: string;

  /**
   * The entire untouched runtime context object, including undocumented
   * fields. Not part of the stable API surface; use for diagnostics and
   * escape hatches only.
   */
  readonly raw: unknown;
}
