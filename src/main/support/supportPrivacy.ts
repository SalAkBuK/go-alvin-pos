import { isSensitiveKey, redactString, sanitizeFields } from '../app/logger';
import { scrubExternalText } from '../google/googleRedaction';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>|]+/g;
const POSIX_PRIVATE_PATH_PATTERN = /\/(?:Users|home|var|tmp)\/[^\s"'<>]+/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Additional bundle-level PII/path scrubbing layered on the central logger redaction. */
export function sanitizeSupportText(value: string): string {
  return scrubExternalText(redactString(value))
    .replace(PRIVATE_KEY_PATTERN, '[redacted-key]')
    .replace(JWT_PATTERN, '[redacted-token]')
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(WINDOWS_PATH_PATTERN, '[redacted-path]')
    .replace(POSIX_PRIVATE_PATH_PATTERN, '[redacted-path]');
}

type PiiContext = 'CUSTOMER' | 'PAYMENT' | null;

function normalized(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, '');
}

function sanitizeStrings(value: unknown, context: PiiContext = null): unknown {
  if (typeof value === 'string') return sanitizeSupportText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeStrings(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        const normalizedKey = normalized(key);
        const stableIdentifier = [
          'supportreportid',
          'bundlecorrelationid',
          'installationid',
          'correlationid',
          'checkoutrequestid',
          'saleid',
          'receiptnumber',
          'exportjobid',
        ].includes(normalizedKey);
        const childContext: PiiContext =
          context ??
          (normalizedKey === 'customer' || normalizedKey === 'customerdata'
            ? 'CUSTOMER'
            : normalizedKey === 'payment' || normalizedKey === 'card' || normalizedKey === 'clover'
              ? 'PAYMENT'
              : null);
        const contextualSecret =
          (context === 'CUSTOMER' &&
            ['name', 'phone', 'phonenumber', 'email', 'address'].includes(normalizedKey)) ||
          (context === 'PAYMENT' &&
            ['number', 'pan', 'cvv', 'cvv2', 'cvc', 'track', 'track1', 'track2'].includes(
              normalizedKey,
            ));
        const directContextValue =
          childContext !== null && (typeof child !== 'object' || child === null);
        return [
          key,
          isSensitiveKey(key) || contextualSecret || directContextValue
            ? '[redacted]'
            : stableIdentifier && typeof child === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(child)
              ? child
              : sanitizeStrings(child, childContext),
        ];
      }),
    );
  }
  return value;
}

/** Sanitize arbitrary nested data before it can enter a report or archive. */
export function sanitizeSupportValue(value: unknown): unknown {
  return sanitizeStrings(sanitizeFields({ value })['value']);
}

const UNSAFE_VALUE_PATTERNS = [
  PRIVATE_KEY_PATTERN,
  JWT_PATTERN,
  EMAIL_PATTERN,
  WINDOWS_PATH_PATTERN,
  POSIX_PRIVATE_PATH_PATTERN,
  /\bBearer\s+(?!\[redacted\])\S+/gi,
  /\b(?:access_token|refresh_token|id_token|code_verifier|authorization_code|client_secret|password|cvv2?|cvc|card_number)"?\s*[:=]\s*"?(?!\[redacted\])[^\s,"}]+/gi,
] as const;

/** Final fail-closed scan: sanitization is not trusted as the only privacy boundary. */
export function assertPrivacySafeText(value: string): void {
  for (const pattern of UNSAFE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) throw new Error('Support content failed privacy validation.');
  }
}
