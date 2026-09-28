# Global Error Handler Installer

Attaches a single callback to every platform-appropriate uncaught-error source (browser `window.onerror` / `window.onunhandledrejection`, or Node `process` `uncaughtException` / `unhandledRejection`) and delivers each as a normalized event object.

```js
import { installGlobalErrorHandler, uninstallGlobalErrorHandler } from 'global-error-handler-installer';

const handle = installGlobalErrorHandler((event) => {
  console.log(event.source, event.message, event.error);
});

// later
handle.uninstall();
// or
uninstallGlobalErrorHandler();
```

The normalized event has the shape `{ source, message, error, value, filename, lineno, colno, timestamp }`. `error` is the original `Error` instance when one is available, otherwise `null`. `filename`/`lineno`/`colno` are populated only on the browser `window.onerror` path; they are `null` everywhere else.

## Why this exists

Production error reporting code usually wants one place that receives every kind of uncaught failure, regardless of whether it came from a synchronous throw, a rejected promise, or (in Node) an uncaught exception. Writing that wiring by hand is repetitive and easy to get wrong — particularly the differences between `window.onerror`'s positional-argument form and its `ErrorEvent` form, and the fact that a handler that itself throws will recurse infinitely.

The trade-off: this library is deliberately thin. It does not batch, retry, serialize, or transport events. It normalizes and routes, nothing more. If you need backoff or upload, layer that on top of the callback.

## Edge cases worth knowing

- **Idempotent install.** Calling `installGlobalErrorHandler` a second time replaces the first installation rather than adding a second listener. This prevents duplicate deliveries but means you cannot have two independent handlers active at once.
- **Callback exceptions are swallowed.** If your callback throws, the throw is caught and ignored. Re-throwing inside an `uncaughtException` handler would either recurse (browser) or terminate the process (Node), so the library suppresses callback errors by design.
- **No `preventDefault`.** The library does not call `event.preventDefault()` on browser events. Stopping the default console logging is the caller's responsibility; the normalized event carries the original `error` so you can decide.
- **Browser detection is feature-based.** It checks for `window.addEventListener`, not for a specific runtime, so jsdom-style environments attach to `window` rather than `process`.
