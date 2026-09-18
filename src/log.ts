/**
 * The one thing both logs need and neither should reimplement.
 *
 * `--log-level debug` puts whole bodies on stdout: a TwiML document, a JSON resource, the
 * form a webhook was signed over. Those are worth seeing and none of them is worth seeing
 * in full — a recording resource is small, but the same code path also meets a WAV. So a
 * preview is truncated and *says* it was truncated, because a body silently cut at a
 * boundary reads as a malformed document, which is the bug this log exists to rule out.
 */

const DEFAULT_MAX = 2000;

export function preview(value: unknown, max: number = DEFAULT_MAX): string {
  const text = typeof value === 'string' ? value : safeStringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length - max} more)`;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular or otherwise unserialisable payload. Naming the type beats throwing from
    // inside a log call.
    return `[unserialisable ${typeof value}]`;
  }
}
