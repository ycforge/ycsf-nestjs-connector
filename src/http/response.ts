/**
 * Response envelope the function runtime expects from an HTTP invocation.
 *
 * Evidence level: **documented** (Yandex Cloud Functions proxy integration,
 * same contract family as API Gateway v2 responses).
 */
export interface YandexFunctionHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Body payload encoded according to {@link isBase64Encoded}. */
  readonly body: string;
  readonly isBase64Encoded: boolean;
}
