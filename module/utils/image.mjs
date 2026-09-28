/** @layer utils */

/**
 * Load an image into an element.
 *
 * Cross-origin is requested by default so the pixels can be read back. A data URL doesn't need it. A host that
 * sends no CORS headers refuses a cross-origin request outright, so with `retryWithoutCors` the image loads again
 * without it: the layer then displays even though its pixels can't be read. `downloadImage` in editor/io.mjs sets
 * that retry for other-origin URLs.
 * @param {string} src                            Path, URL or data URL.
 * @param {object} [options]
 * @param {string|null} [options.crossOrigin='anonymous']   The crossOrigin attribute, or null to omit it.
 * @param {boolean} [options.retryWithoutCors=false]        Retry plainly when the cross-origin load fails.
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(src, { crossOrigin = 'anonymous', retryWithoutCors = false } = {}) {
  const attempt = (withCors) => new Promise((resolve, reject) => {
    const img = new Image();
    if (withCors && crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
  if (!retryWithoutCors) return attempt(true);
  return attempt(true).catch(err => attempt(false).catch(() => { throw err; }));
}
