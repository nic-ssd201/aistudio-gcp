/**
 * Edge Runtime compatible logger for authentication modules
 *
 * This logger is designed to work in Edge Runtime environments where Node.js APIs
 * are not available. It provides structured logging that can be captured by
 * monitoring systems without violating Edge Runtime constraints.
 *
 * Security Note: In production, token metadata logging is sanitized to prevent
 * potential information disclosure through logs.
 */

interface EdgeLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  debug: (message: string, meta?: Record<string, unknown>) => void
}

interface LogContext {
  context: string
  tokenSub?: string
  [key: string]: unknown
}

// No global state - each logger instance is self-contained

/**
 * Creates an Edge Runtime compatible logger instance
 *
 * @param context - Logging context including module name and optional token identifier
 * @returns EdgeLogger instance with info, warn, error, and debug methods
 */
export function createEdgeLogger(context: LogContext): EdgeLogger {
  // Sanitize token sub in production to prevent information disclosure
  const sanitizedTokenSub = process.env.NODE_ENV === 'production' && context.tokenSub
    ? context.tokenSub.substring(0, 8) + '***'
    : context.tokenSub || 'unknown'

  /**
   * Sanitizes metadata to prevent sensitive information leakage in logs
   * Removes or truncates potentially sensitive fields
   */
  const sanitizeMetadata = (meta?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!meta) return undefined

    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(meta)) {
      // Don't log actual token values or sensitive data
      if (key.toLowerCase().includes('token') && typeof value === 'string' && value.length > 20) {
        sanitized[key] = '[REDACTED_TOKEN]'
      } else if (key === 'tokenSub' && typeof value === 'string' && process.env.NODE_ENV === 'production') {
        sanitized[key] = value.substring(0, 8) + '***'
      } else if (key === 'error' && typeof value === 'string') {
        // Redact credential-like substrings from error messages.
        // Two-pass to balance coverage vs. false-positive rate:
        //   (1) Standard base64 (with padding): any 20+ char run that ends in
        //       one or two `=` signs — the `=` discriminates real base64 from
        //       UUIDs (32 hex, no `=`), commit SHAs (40 hex, no `=`), and GCP
        //       resource names that look alphanumeric but lack padding.
        //   (2) Long bare base64url (no padding): 64+ chars of [A-Za-z0-9_-].
        //       Anything this long is almost certainly a JWT segment or API key;
        //       legitimate debug values (UUIDs, SHAs) are all shorter than 64 chars.
        //       Known over-redaction cases: long GCS object names (e.g. UUIDs with
        //       path segments), base64-encoded image data URIs in error messages,
        //       and long alphanumeric stack-frame identifiers.  The accepted
        //       trade-off is occasional loss of these identifiers in exchange for
        //       preventing accidental key/token leakage via error log fields.
        // The previous 20-char catch-all clobbered too much: UUIDs, commit SHAs,
        // package version hashes, and stack-frame names were all silently destroyed.
        sanitized[key] = value
          .replace(/[A-Za-z\d+/]{20,}={1,2}/g, '[REDACTED_TOKEN]')
          .replace(/[A-Za-z\d_-]{64,}/g, '[REDACTED_TOKEN]')
      } else {
        sanitized[key] = value
      }
    }

    return sanitized
  }

  const logMessage = (level: string, message: string, meta?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString()
    const contextString = `${context.context}[${sanitizedTokenSub}]`
    const sanitizedMeta = sanitizeMetadata(meta)
    const formattedMessage = `[${timestamp}] ${contextString} ${level}: ${message}`
    const metaString = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : ''

    try {
      // ERROR and WARN are always emitted — Cloud Run captures stderr/stdout so
      // operators see auth failures, dedup-cap hits, malformed token responses,
      // and loginIat regression warnings in production without any extra config.
      // INFO and DEBUG stay development-only to avoid log noise in production.
      if (level === 'ERROR') {
        // eslint-disable-next-line no-console
        console.error(`${formattedMessage}${metaString}`)
      } else if (level === 'WARN') {
        // eslint-disable-next-line no-console
        console.warn(`${formattedMessage}${metaString}`)
      } else if (process.env.NODE_ENV === 'development') {
        // INFO / DEBUG — development only

        // Optionally forward to a DEBUG_LOG_ENDPOINT (Edge Runtime compatible)
        if (process.env.DEBUG_LOG_ENDPOINT) {
          fetch(process.env.DEBUG_LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level, message, timestamp, context: contextString, meta: sanitizedMeta }),
          }).catch(() => {
            // Silently fail if logging endpoint unavailable
          })
        }

        // eslint-disable-next-line no-console
        console.log(`${formattedMessage}${metaString}`)
      }
    } catch {
      // Silently fail if any logging mechanism fails
      // This ensures the logger never breaks the application
    }
  }

  return {
    info: (message: string, meta?: Record<string, unknown>) => {
      logMessage('INFO', message, meta)
    },

    warn: (message: string, meta?: Record<string, unknown>) => {
      logMessage('WARN', message, meta)
    },

    error: (message: string, meta?: Record<string, unknown>) => {
      logMessage('ERROR', message, meta)
    },

    debug: (message: string, meta?: Record<string, unknown>) => {
      // Only log debug messages in development to reduce production overhead
      if (process.env.NODE_ENV === 'development') {
        logMessage('DEBUG', message, meta)
      }
    }
  }
}

/**
 * Alias for createEdgeLogger to maintain compatibility with existing createLogger calls
 * This allows existing code to use the same function name while getting Edge Runtime compatibility
 */
export const createLogger = createEdgeLogger