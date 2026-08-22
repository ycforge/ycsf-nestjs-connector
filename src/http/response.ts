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
   * Evidence level: **provisional — pending live verification**. The captured
   * dataset in DATA-ANALYSE.md covers invocation *requests* only (which show
   * no `multiValueHeaders` counterpart), so whether payload-format-2.0
   * *responses* accept this field is not observed. It exists because the
   * alternative representations are worse: comma-joining repeated values is
   * lossy (a comma is legal inside Set-Cookie attributes) and dropping them
   * breaks multi-cookie responses. Per the documented proxy-integration
   * behavior a header listed here overrides the same name in `headers`.
   * Consumers relying on this field should verify it against a live function.
   */
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[]>>;
  /** Body payload encoded according to {@link isBase64Encoded}. */
  readonly body: string;
  readonly isBase64Encoded: boolean;
}
