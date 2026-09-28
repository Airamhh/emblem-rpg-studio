/** @layer foundry */
import { StudioRefusal } from '../admission.mjs';

/* -------------------------------------------- */
/*  Notifications                               */
/* -------------------------------------------- */
const reportedErrors = new WeakSet();
const recentNotices = new Map();

/**
 * Studio's user feedback, bound to the file that owns the operation. Each Studio file makes one with its own
 * `import.meta.url`.
 * - `info` and `warn` show a toast as given.
 * - `failure` logs the message and error to the console and shows a generic "layer error" toast naming the
 *   failing folder. A StudioRefusal shows its own message as a warning instead. The same error is shown once, and
 *   a repeat of the same toast within a second is dropped.
 * - `error` is `failure` without an error object.
 * - `probe` logs an expected failure at debug level, or treats an unexpected one as a `failure`.
 * - `validation` logs and shows its message as a warning.
 */
export function createStudioNotifier(sourcePath) {
  const show = (level, message, options) => {
    try { return globalThis.ui?.notifications?.[level]?.(message, options); } catch {}
  };
  const refusal = (error, notify) => {
    try {
      const path = studioSource(error, sourcePath).path;
      console.warn(`Emblem RPG Studio | ${path}: ${error.message}`, error.code);
      const key = `${path}|${error.code}`;
      const now = Date.now();
      if (!notify || now - (recentNotices.get(key) ?? -Infinity) < 1000) return;
      recentNotices.set(key, now);
      return show('warn', error.message);
    } catch {}
  };
  const failure = (message, error = null, recovery = null, notify = true) => {
    if (error instanceof StudioRefusal) return refusal(error, notify);
    try {
      const source = studioSource(error, sourcePath);
      try { console.error(`Emblem RPG Studio | ${source.path}: ${message}`, error ?? '', { recovery }); } catch {}
      if (!notify) return;
      if (error instanceof Error && recovery?.status !== 'restored') {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
      }
      const key = `${source.path}|${message}|${recovery?.status ?? ''}`;
      const now = Date.now();
      if (now - (recentNotices.get(key) ?? -Infinity) < 1000) return;
      recentNotices.set(key, now);
      for (const [id, time] of recentNotices) if (now - time >= 1000) recentNotices.delete(id);
      const restored = recovery?.status === 'restored' && recovery?.state;
      return show('error', restored
        ? `${source.label} layer error: ${recovery.state} restored. See console for more details`
        : `${source.label} layer error. See console for more details`, { console: false });
    } catch {}
  };
  const probe = (message, error, expected = true) => {
    if (!expected) return failure(message, error);
    try { console.debug(`Emblem RPG Studio | ${studioSource(error, sourcePath).path}: ${message}`, error); } catch {}
  };
  const validation = (message, error, expected = true) => {
    if (!expected) return failure(message, error);
    try { console.warn(`Emblem RPG Studio | ${studioSource(error, sourcePath).path}: ${message}`, error); } catch {}
    return show('warn', message);
  };
  return Object.freeze({
    info: (message, options) => show('info', message, options),
    warn: (message, options) => show('warn', message, options),
    error: message => failure(message),
    failure,
    probe,
    validation
  });
}

/* -------------------------------------------- */
/*  Failure origin                              */
/* -------------------------------------------- */

/**
 * The Studio file a failure came from: the first Studio file in the stack of the deepest error in its `cause` chain
 * (the error itself included) that names one, or else the notifier's own file. `label` names its folder for the
 * toast, such as "Character /fecc".
 */
function studioSource(error, sourcePath) {
  let stackPath = '';
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth += 1) {
    stackPath = String(cause?.stack ?? '').replaceAll('\\', '/')
      .match(/emblem-rpg-studio\/module\/([a-z][a-z0-9/-]*\.mjs)/i)?.[1] || stackPath;
  }
  const path = stackPath || String(sourcePath ?? '').replaceAll('\\', '/').split('/module/').at(-1)
    .replace(/[?#].*$/, '');
  const parts = path.split('/');
  const layer = parts.length > 1 ? parts[0] : 'studio';
  const label = `${layer[0].toUpperCase()}${layer.slice(1)}${parts.length > 2 ? ` /${parts[1]}` : ''}`;
  return { path, label };
}

/* -------------------------------------------- */
/*  Uncaught failures                           */
/* -------------------------------------------- */

/**
 * Report uncaught errors and rejected promises whose stack runs through a Studio file, and leave the events
 * themselves unchanged. installStudioHooks (foundry/hooks.mjs) starts it at load.
 */
export function observeStudioErrors() {
  const report = (error, detail) => {
    try { if (studioSource(error, '').path) createStudioNotifier('').failure(detail, error); } catch {}
  };
  Hooks.on('error', (location, error) => report(error, String(location)));
  globalThis.addEventListener('unhandledrejection', event => report(event.reason, 'Unhandled promise rejection'));
  globalThis.addEventListener('error', event => report(event.error, 'Unhandled script error'));
}
