/**
 * Response envelope the function runtime expects from an HTTP invocation.
 *
 * Evidence level: **documented** (Yandex Cloud Functions proxy integration,
 * same contract family as API Gateway v2 responses). The platform rejects
 * envelopes that are not strictly valid JSON (`Malformed serverless function
 * response`), so serialization must stay deterministic.
 */
export interface YandexFunctionHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Multi-value header map, emitted **only** when a handler appended more
   * than one value to the same header (typically multiple `Set-Cookie`
   * lines); single-valued responses keep the exact four-field envelope
   * established before issue #6.
   *
   * Evidence level: **documented** for proxy-integration responses — per the
   * Yandex docs a header listed here overrides the same name in `headers`.
   * Whether payload format 2.0 responses accept this field was not captured
   * in DATA-ANALYSE.md (the dataset covers request events), so multiplicity
   * is preserved through it rather than invented: without it, repeated
   * headers would have to be lossily comma-joined or dropped.
   */
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[]>>;
  /** Body payload encoded according to {@link isBase64Encoded}. */
  readonly body: string;
  readonly isBase64Encoded: boolean;
}
