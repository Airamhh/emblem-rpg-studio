/** @layer editor */
/* -------------------------------------------- */

/**
 * One layer of a CanvasView (canvas-view.mjs): an image, its transform, and what it needs to be recoloured. Studio
 * builds sprites from stacked layers, so almost everything here is per layer. The palette in particular is cloned
 * per layer, so the colour panel can recolour one part without changing the others.
 */
export class ImageLayer {
  /* -------------------------------------------- */

  /**
   * @param {HTMLImageElement|HTMLCanvasElement} image       The layer's pixels.
   * @param {object} [opts]                                  Transform, naming and asset metadata.
   */
  constructor(image, opts = {}) {
    this.id = foundry.utils.randomID();
    this.image = image;
    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    this.rotation = opts.rotation ?? 0;
    this.scale = opts.scale ?? 1;
    this.flipX = !!opts.flipX;
    this.flipY = !!opts.flipY;
    this.opacity = opts.opacity ?? 1;
    this.visible = opts.visible !== false;

    // The name the user gave the layer in the layers panel, or null for the automatic "Layer N" label. It is not
    // feccName, which identifies the template part.
    this.customName = opts.customName ? String(opts.customName) : null;

    // Palette-indexed part details, set when the layer came from the parts library. `isFecc` turns on palette
    // recolouring, `feccType` picks the palette family, and `feccName` names the template part.
    this.isFecc   = !!opts.isFecc;
    this.feccType = opts.feccType ?? null;
    this.feccName = opts.feccName ?? null;
    // A custom part keeps its world URL, since only shipped parts can be found again from the part name.
    this._sourceUrl = opts.sourceUrl ?? null;
    // Cloned, so editing this layer's palette never changes a shared template's.
    this._feccPalette = opts.palette
      ? JSON.parse(JSON.stringify(opts.palette))
      : null;
    // The recoloured canvas, cached by palette hash.
    this._recolourCacheKey = null;
    this._recolourCache    = null;
  }

  /* -------------------------------------------- */
  /*  Dimensions                                  */
  /* -------------------------------------------- */

  /** The image's width in pixels. */
  get width()  { return this.image.naturalWidth || this.image.width || 0; }
  /* -------------------------------------------- */

  /** The image's height in pixels. */
  get height() { return this.image.naturalHeight || this.image.height || 0; }

  /* -------------------------------------------- */

  /**
   * Whether the palette still controls what the user sees, as the layers panel's chain icon shows. Pixel edits
   * (cut, paint, fill) keep the link, because the edited canvas still holds palette-indexed pixels. Whether the layer
   * could be rebuilt from the parts manifest is a separate question, and pixel edits do end that.
   * @type {boolean}
   */
  get isPaletteLinked() {
    return !!this.isFecc;
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Draw the layer with its full transform. The context is moved to the canvas centre first, so position, rotation
   * and scale are all relative to the middle of the sprite, since a token's art is composed around its centre. The
   * recoloured cache is drawn instead of the source when there is one, so a palette change shows without touching
   * the original image.
   * @param {CanvasRenderingContext2D} ctx          Target context.
   * @param {number} canvasSize                     The composition's size.
   */
  draw(ctx, canvasSize) {
    if (!this.image || !this.visible) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(canvasSize / 2 + this.x, canvasSize / 2 + this.y);
    ctx.rotate(this.rotation);
    const sx = this.scale * (this.flipX ? -1 : 1);
    const sy = this.scale * (this.flipY ? -1 : 1);
    ctx.scale(sx, sy);
    const src = this._recolourCache ?? this.image;
    ctx.drawImage(src, -this.width / 2, -this.height / 2);
    ctx.restore();
  }

  /* -------------------------------------------- */
  /*  Coordinates                                 */
  /* -------------------------------------------- */

  /**
   * Whether a canvas pixel falls inside this layer, transform included.
   * @param {number} px                     Canvas x.
   * @param {number} py                     Canvas y.
   * @param {number} canvasSize             The composition's size.
   * @returns {boolean}
   */
  hitTest(px, py, canvasSize) {
    const localX = px - (canvasSize / 2 + this.x);
    const localY = py - (canvasSize / 2 + this.y);
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    let rx = localX * cos - localY * sin;
    let ry = localX * sin + localY * cos;
    const sx = this.scale * (this.flipX ? -1 : 1) || 1;
    const sy = this.scale * (this.flipY ? -1 : 1) || 1;
    rx /= sx;
    ry /= sy;
    return Math.abs(rx) <= this.width / 2 && Math.abs(ry) <= this.height / 2;
  }

  /* -------------------------------------------- */

  /**
   * The layer-image pixel that the transform places at a given canvas pixel: the inverse of `draw`, with the same
   * arithmetic as the hit test. The pixel tools reach layer pixels through here (via
   * `CanvasView#_canvasCellToLayer`), so a rotated or flipped layer is painted where the cursor is.
   * @param {number} px                                     Canvas x.
   * @param {number} py                                     Canvas y.
   * @param {number} canvasSize                             The composition's size.
   * @returns {{x: number, y: number}}
   */
  canvasToLayer(px, py, canvasSize) {
    const localX = px - (canvasSize / 2 + this.x);
    const localY = py - (canvasSize / 2 + this.y);
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    let rx = localX * cos - localY * sin;
    let ry = localX * sin + localY * cos;
    const sx = this.scale * (this.flipX ? -1 : 1) || 1;
    const sy = this.scale * (this.flipY ? -1 : 1) || 1;
    rx /= sx;
    ry /= sy;
    return { x: rx + this.width / 2, y: ry + this.height / 2 };
  }
}
