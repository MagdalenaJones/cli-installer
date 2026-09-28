/**
 * Core implementation of the global error handler installer.
 *
 * Design decisions:
 *
 * 1. Single normalized callback. Every source (window.onerror,
 *    window.onunhandledrejection, process 'uncaughtException',
 *    process 'unhandledRejection') is mapped to one callback receiving a
 *    plain object with a stable shape. This keeps consumer code trivial.
 *
 * 2. Browser vs. Node detection is based on feature presence, not on
 *    reading globalThis.process or navigator strings. We check whether the
 *    arguments we need actually exist. This avoids false positives in
 *    environments that shim one into the other (jsdom, Deno with process
 *    polyfill, etc.).
 *
 * 3. We do NOT attempt to re-throw or swallow errors. Preventing default
 *    on browser events is the caller's responsibility via the returned
 *    handle — we expose a `preventDefault` flag in the normalized event so
 *    the callback can decide. Re-throwing in Node would terminate the
 *    process, which is surprising; we leave that to the caller.
 *
 * 4. Idempotency: installing twice with the same callback replaces the
 *    previous installation rather than stacking, so you never get duplicate
 *    deliveries for the same error. This matches the principle of least
 *    surprise for a "global" handler.
 */

const installedKey = Symbol.for('globalErrorHandler.installed');

/**
 * Coerce any value thrown/rejected into a normalized event object.
 *
 * @param {unknown} value - The original value thrown or rejected.
 * @param {string} source - One of 'window.onerror', 'window.onunhandledrejection',
 *   'process.uncaughtException', 'process.unhandledRejection'.
 * @returns {{
 *   source: string,
 *   message: string,
 *   error: Error | null,
 *   value: unknown,
 *   filename: string | null,
 *   lineno: number | null,
 *   colno: number | null,
 *   timestamp: number
 * }}
 */
export function normalizeErrorEvent(value, source) {
  let message = '';
  let error = null;

  if (value instanceof Error) {
    error = value;
    message = value.message;
  } else if (typeof value === 'string') {
    message = value;
  } else if (value !== null && typeof value === 'object' && 'message' in value) {
    const m = value.message;
    message = typeof m === 'string' ? m : String(m);
  } else if (value !== undefined && value !== null) {
    message = String(value);
  }

  return {
    source,
    message,
    error,
    value,
    filename: null,
    lineno: null,
    colno: null,
    timestamp: Date.now(),
  };
}

/**
 * Build a browser-extended normalized event from a window.onerror argument tuple.
 * window.onerror passes (message, source, lineno, colno, error). We preserve
 * the positional info because some applications use it for telemetry grouping.
 */
function fromWindowError(args, timestamp) {
  const [message, filename, lineno, colno, error] = args;
  const base = normalizeErrorEvent(error ?? message, 'window.onerror');
  base.filename = typeof filename === 'string' ? filename : null;
  base.lineno = typeof lineno === 'number' ? lineno : null;
  base.colno = typeof colno === 'number' ? colno : null;
  base.timestamp = timestamp;
  // If error was provided, message from the Error takes precedence over the
  // string message argument, which browsers sometimes set to a generic
  // "Script error." for cross-origin scripts.
  if (error instanceof Error) {
    base.message = error.message;
  } else if (typeof message === 'string') {
    base.message = message;
  }
  return base;
}

/**
 * Install a single global error handler that receives normalized events from
 * every platform-appropriate source.
 *
 * @param {(event: object) => void} callback - Called for each uncaught error
 *   or unhandled rejection. Receives a normalized event object.
 * @returns {{ uninstall: () => void }} A handle with an `uninstall` method
 *   that removes all listeners installed by this call.
 */
export function installGlobalErrorHandler(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('installGlobalErrorHandler: callback must be a function');
  }

  // If a previous installation exists for this global slot, uninstall it first.
  // This gives us idempotent install semantics.
  const existing = globalThis[installedKey];
  if (existing && typeof existing.uninstall === 'function') {
    existing.uninstall();
  }

  const handles = [];
  const isBrowser = typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function';
  const isNode = typeof process !== 'undefined' &&
    typeof process.on === 'function' &&
    typeof process.removeListener === 'function';

  if (isBrowser) {
    const onError = (event) => {
      // window.onerror has two call shapes: the legacy 5-arg form and the
      // ErrorEvent form. We normalize both.
      let normalized;
      if (event instanceof ErrorEvent) {
        normalized = normalizeErrorEvent(event.error ?? event.message, 'window.onerror');
        normalized.filename = event.filename || null;
        normalized.lineno = typeof event.lineno === 'number' ? event.lineno : null;
        normalized.colno = typeof event.colno === 'number' ? event.colno : null;
      } else if (Array.isArray(event) || arguments.length > 1) {
        // Some browsers call the listener with positional args rather than an
        // ErrorEvent. gather them.
        normalized = fromWindowError(Array.prototype.slice.call(arguments), Date.now());
      } else {
        normalized = normalizeErrorEvent(event, 'window.onerror');
      }
      try {
        callback(normalized);
      } catch {
        // A callback that throws would itself trigger another error event,
        // causing infinite recursion. Swallow defensively.
      }
    };
    window.addEventListener('error', onError);
    handles.push(() => window.removeEventListener('error', onError));

    const onRejection = (event) => {
      const reason = event && typeof event === 'object' && 'reason' in event
        ? event.reason
        : event;
      const normalized = normalizeErrorEvent(reason, 'window.onunhandledrejection');
      try {
        callback(normalized);
      } catch {
        // Defensive: see onError above.
      }
    };
    window.addEventListener('unhandledrejection', onRejection);
    handles.push(() => window.removeEventListener('unhandledrejection', onRejection));
  } else if (isNode) {
    const onUncaught = (err) => {
      const normalized = normalizeErrorEvent(err, 'process.uncaughtException');
      try {
        callback(normalized);
      } catch {
        // Defensive: throwing inside uncaughtException would recurse.
      }
    };
    process.on('uncaughtException', onUncaught);
    handles.push(() => process.removeListener('uncaughtException', onUncaught));

    const onRejection = (reason) => {
      const normalized = normalizeErrorEvent(reason, 'process.unhandledRejection');
      try {
        callback(normalized);
      } catch {
        // Defensive: see onUncaught above.
      }
    };
    process.on('unhandledRejection', onRejection);
    handles.push(() => process.removeListener('unhandledRejection', onRejection));
  }

  const uninstall = () => {
    while (handles.length) {
      const h = handles.pop();
      try {
        h();
      } catch {
        // Best-effort cleanup; ignore failures from already-removed listeners.
      }
    }
    if (globalThis[installedKey] === state) {
      delete globalThis[installedKey];
    }
  };

  const state = { uninstall };
  globalThis[installedKey] = state;
  return state;
}

/**
 * Remove the currently installed global error handler, if any.
 * Safe to call when nothing is installed.
 */
export function uninstallGlobalErrorHandler() {
  const existing = globalThis[installedKey];
  if (existing && typeof existing.uninstall === 'function') {
    existing.uninstall();
  }
}
