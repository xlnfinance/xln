/**
 * `this` brand for native / generator-lambda apply (call-function.ts). Identity only:
 * membrane keys `instanceof` to pass calls through unwrapped — no payload fields.
 *
 * Private `#brand` keeps the class nominally distinct (empty body would be `{}`-like
 * under structural typing and poison `BoxedSchemeValue` / AmbientRuntime.bind).
 */
export class LambdaContext {
  // Nominal brand — unread on purpose; empty body would be structurally `{}`.
  // eslint-disable-next-line no-unused-private-class-members
  readonly #brand = "LambdaContext" as const;
}
