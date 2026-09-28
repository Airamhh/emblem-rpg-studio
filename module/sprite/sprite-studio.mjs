/** @layer sprite-studio */
import { createStudioNotifier } from '../foundry/notify.mjs';
import { CanvasView } from '../editor/canvas-view.mjs';
import {
  downloadImage, pickLocalImage,
  ensureFolderHierarchy, uploadBlob, itemArtFolder, itemArtFilename,
  itemPackedAssetFolder, itemPackedAssetFilename, packedAssetPackageLabel,
  developerMode, syncSaveToRootVisibility
} from '../editor/io.mjs';
import { DEVELOPER_MODE_HOOK, MODULE_ID, SPRITE_STUDIO_TEMPLATE } from '../constants.mjs';
import { savedPixelArtUpdate } from '../foundry/documents.mjs';
import { STUDIO_REFUSALS } from '../admission.mjs';
import { isStudioStaff, refuseStudio } from '../foundry/access.mjs';
import { pixelArtCropTransparent } from '../utils/pixel-art.mjs';
import { FeccColourPanel } from '../character/fecc/fecc-colour-panel.mjs';
import { EmblemApp } from '../editor/app.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */

/** Handlebars template for the studio. */
const TEMPLATE = SPRITE_STUDIO_TEMPLATE;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * The update for art the studio just saved: the path and pixel-art marker, plus a save stamp. A re-save to the file
 * the item already uses changes neither of the first two, and Foundry drops an update with nothing in it, so the
 * stamp is what makes the save a real change: `_stats.modifiedTime` moves, and the system's sheets, which add it to
 * the art's URL, fetch the new file.
 * @param {string} path                   Where the art was stored.
 * @returns {object}                      A flat update payload for `Document#update`.
 */
function savedArtUpdate(path) {
  return { ...savedPixelArtUpdate(path), [`flags.${MODULE_ID}.artSavedAt`]: Date.now() };
}

/* -------------------------------------------- */

/**
 * An art path with a cache-busting query, so a file overwritten at the same path is read from disk again. Data and
 * blob URLs are returned as they are.
 * @param {string} path                   Stored path.
 * @returns {string}
 */
function bustedArtPath(path) {
  if (/^(data|blob):/i.test(path)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${Date.now()}`;
}

/* -------------------------------------------- */

/**
 * The item art editor: a single-layer pixel canvas with recolour and adjustment trays. The system's
 * `openStudioForItem` opens it through `api.openSpriteStudio` when a GM right-clicks an item sheet's portrait.
 *
 * It uses the shared editor canvas (`CanvasView` in editor/canvas-view.mjs), the same one Character Studio uses, so
 * item art and character art reduce, place and paint identically. It edits one destination: this item's image.
 *
 * Two save targets. The ordinary one writes into the world and points the item at it. Save To Root, shown only in
 * Developer Mode, writes into the Emblem RPG Content module's asset tree instead, beside the bundled art it will be
 * packed with, which is how the compendium source is edited.
 */
export class EmblemSpriteStudio extends EmblemApp {
  /* -------------------------------------------- */

  /**
   * @param {Item} item                     Item whose art is being edited.
   * @param {object} [options]              Application options.
   */
  constructor(item, options = {}) {
    super(options);
    this.item = item;
    this.view = null;
    this._mounted = false;
    this._colourPanel = null;
    this._adjustWired = false;
    this._adjustBusy = false;  // guards selection-change reentrancy during apply/cancel
  }

  /* -------------------------------------------- */
  /*  Configuration                               */
  /* -------------------------------------------- */

  static TITLE = 'Emblem Sprite Studio';

  /* -------------------------------------------- */

  /** The tray body's width. The window opens wide enough for the rail and a tray, since a tray is always open. */
  static RECOLOUR_PANE_WIDTH = 251;

  /* -------------------------------------------- */

  /**
   * The trays, in rail order. The first is open when the window is built.
   *
   * One of them is always open, because a rail with everything collapsed would leave the pane empty for no gain. So
   * the rail tabs switch between trays instead of toggling one on and off.
   */
  static TRAY_KEYS = ['adjust', 'colour'];

  /* -------------------------------------------- */

  static DEFAULT_OPTIONS = {
    id: 'emblem-sprite-studio-{id}',
    classes: ['emblem-rpg-studio', 'emblem-sprite-studio'],
    tag: 'div',
    window: { title: 'Emblem Sprite Studio', icon: 'fas fa-wand-magic-sparkles', resizable: true },
    position: { width: 560 + EmblemSpriteStudio.RECOLOUR_PANE_WIDTH, height: 660 },
    actions: {
      save:           EmblemSpriteStudio.#onSave,
      saveToRoot:     EmblemSpriteStudio.#onSaveRoot,
      cancel:         EmblemSpriteStudio.#onCancel,
      importImage:    EmblemSpriteStudio.#onImport,
      clearArt:       EmblemSpriteStudio.#onClear,
      toggleTray:     EmblemSpriteStudio.#onToggleTray,
      adjustApply:    EmblemSpriteStudio.#onAdjustApply,
      adjustCancel:   EmblemSpriteStudio.#onAdjustCancel,
      adjustReset:    EmblemSpriteStudio.#onAdjustReset
    }
  };

  /* -------------------------------------------- */

  static PARTS = { main: { template: TEMPLATE } };

  /* -------------------------------------------- */

  /** The item's name, shown after the window title. */
  _titleSubject() { return this.item?.name ?? ''; }

  /* -------------------------------------------- */

  /**
   * Repaint the window title so the edited item reads as the studio's subject.
   *
   * ApplicationV2 writes the title as escaped text, so the two-tone label can only exist as post-render DOM.
   * @private
   */
  _paintWindowTitle() {
    const heading = this.element?.querySelector('.window-header .window-title');
    if (!heading) return;
    const subject = this._titleSubject();
    const base = this._titleBase();
    heading.innerHTML = subject
      ? `${base} <span class="sts-title-subject">${foundry.utils.escapeHTML(subject)}</span>`
      : base;
  }

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /**
   * Open the studio for an item, refusing an opening with nothing to edit.
   *
   * Staff only: a Trusted Player may edit art only for Actors they own, and item art isn't that.
   * @param {Item} item                             Item to edit.
   * @returns {EmblemSpriteStudio|null}
   */
  static open(item) {
    if (!item) return null;
    if (!isStudioStaff()) return refuseStudio(STUDIO_REFUSALS.STAFF_ONLY, 'use Sprite Studio');
    return super.open(item);
  }

  /* -------------------------------------------- */

  /**
   * One studio per item, since two would each hold their own canvas and one save would overwrite the other.
   * @param {Item} item                             Item to edit.
   * @returns {string|null}
   */
  static _instanceKey(item) { return item?.uuid ?? null; }

  /* -------------------------------------------- */

  /**
   * Encode the full UUID without collisions so embedded items get separate window registrations.
   * @param {Item} item                             Item to edit.
   * @returns {EmblemSpriteStudio}
   */
  static _create(item) {
    const id = Array.from(item.uuid, character => character.codePointAt(0).toString(16)).join('-');
    return new this(item, { id: `emblem-sprite-studio-${id}` });
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** Template data: the item's name, and whether Save To Root shows. */
  async _prepareContext() {
    return { itemName: this.item?.name ?? 'Item', showSaveToRoot: developerMode() };
  }

  /* -------------------------------------------- */

  /**
   * Mount the canvas and wire everything, once.
   *
   * A mounted flag stops later renders from doing it again, because the canvas holds the art being edited and
   * rebuilding it would discard the work. For the same reason, the Developer Mode hook shows or hides Save To Root
   * without a re-render.
   *
   * Selection changes go to both trays. The recolour panel needs to know which pixels to act on, and the adjustment
   * tray has to discard a preview whose selection has moved.
   *
   * Layer-state changes go to the recolour panel too, so the two trays don't undo each other's work. The panel maps
   * tones from a snapshot of the layer and rewrites the whole layer from it, so without a refresh the next tone edit
   * would wipe out an adjustment made since. `refreshFromLayer` rebuilds the snapshot from the adjusted pixels. The
   * panel's own writes set a flag that makes the refresh do nothing, so a recolour doesn't rebuild its own baseline.
   *
   * The same callback enables or disables the adjustment tray, because whether there's anything to adjust depends on
   * a layer that the art load supplies later, and on every import or clear after it.
   */
  _onRender(context, options) {
    super._onRender(context, options);
    this._paintWindowTitle();
    syncSaveToRootVisibility(this.element);
    this._applyTray();
    if (this._mounted) return;
    this._mounted = true;
    this._onHook(DEVELOPER_MODE_HOOK, (on) => syncSaveToRootVisibility(this.element, on));
    const root = this.element;
    const mount = root.querySelector('.ete-canvas-mount');
    if (!mount) return;
    this.view = new CanvasView({ mountEl: mount, side: 'avatar', initialScale: 1 });
    // Keep the Recolour tray bound to the live layer, which changes on an import or a flatten.
    this.view.onSelectionChange = (layer) => this._colourPanel?.setActivePalette(null, null, layer ?? null);
    this.view.onSelectionMaskChange = (reason) => {
      this._colourPanel?.onCanvasSelectionChanged(reason);
      this._onSelectionChangedForAdjust();
    };
    // An adjustment, an undo or any other pixel write changes the pixels the Recolour tray's snapshot was taken
    // from, and the panel rebuilds the snapshot where the two differ.
    this.view.onLayerStateChanged = (layer) => {
      if (this._colourPanel?._layer === layer) this._colourPanel.refreshFromLayer();
      // An edit or undo keeps an open preview as its own step and ends the session, so the sliders return to
      // neutral rather than re-applying their values on top of the kept result.
      if (!this.view?.hasAdjustSession()) this._resetAdjustSliders();
      this._syncAdjustEnabled();
    };
    this._wireTools(root.querySelector('[data-item-tools]'));
    this._wireAdjustments(root);
    this._loadItemArt()
      .catch(e => { notify.failure('emblem-rpg-studio | item art load failed:', e); })
      .finally(() => this._ensureColourPanel());
  }

  /* -------------------------------------------- */

  /**
   * Build the recolour tray, once a layer exists to bind it to.
   *
   * It isn't built with the window, because the panel binds to a layer and item art loads later. Item art isn't
   * palette-indexed, so the panel uses its per-tone recolour mode on its own.
   */
  _ensureColourPanel() {
    if (this._colourPanel || !this.view) return;
    const root = this.element?.querySelector('[data-recolour-root]');
    if (!root) return;
    this._colourPanel = new FeccColourPanel({
      side: 'avatar',
      root,
      view: this.view,
      layer: this.view.selectedLayer ?? this.view.layers[0] ?? null,
      palette: null,
      feccType: null,
      onChange: () => {},
      onBroadcast: null
    });
  }

  /* -------------------------------------------- */

  /**
   * Wire the tool rail.
   *
   * Only the tools that stay selected get the active marker. One-off actions such as undo, cut and deselect leave
   * the current tool marked instead of looking like a tool of their own.
   * @param {HTMLElement} toolsEl   Tool rail element.
   */
  _wireTools(toolsEl) {
    if (!toolsEl) return;
    const view = this.view;
    const syncActive = (toolName) => {
      toolsEl.querySelectorAll('.ete-tool-btn').forEach(b => {
        if (['pan', 'wand', 'rect', 'move', 'brush', 'fill'].includes(b.dataset.tool)) {
          b.classList.toggle('is-active', b.dataset.tool === toolName);
        }
      });
    };
    toolsEl.querySelectorAll('.ete-tool-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const act = btn.dataset.toolAction;
        if (act === 'undo') { view.undo(); return; }
        if (act === 'redo') { view.redo(); return; }
        if (act === 'brushColor') { view.openBrushColorPicker(btn); return; }
        if (act === 'rotateSelection') { view.rotateSelection(ev.shiftKey ? 90 : 15); return; }
        if (act === 'copySelection') { view.copySelection(); return; }
        if (act === 'pasteSelection') { if (view.pasteSelection()) syncActive('move'); return; }
        const tool = btn.dataset.tool;
        if (!tool) return;
        if (tool === 'cut' || tool === 'deselect') { view.setTool(tool); return; }
        syncActive(tool);
        view.setTool(tool);
      });
    });
  }

  /* -------------------------------------------- */
  /*  Loading                                     */
  /* -------------------------------------------- */

  /**
   * Load the item's current art onto the canvas, through the canvas view's own converter, so item art and Character
   * Studio loads reduce and place identically.
   *
   * A failure is reported and leaves an empty canvas instead of stopping the studio, so art deleted from disk can
   * still be replaced.
   * @returns {Promise<void>}
   */
  async _loadItemArt() {
    const view = this.view, item = this.item;
    const src = item?.img;
    let img = null;
    if (src) { try { img = await downloadImage(bustedArtPath(src)); } catch (_) {
      notify.failure('_loadItemArt failed', _);
    } }
    if (!img) return;
    view.loadImageAsPixelArt(img);
    this._frameLoadedArt();
  }

  /* -------------------------------------------- */

  /**
   * Replace the canvas with an image from the user's machine.
   * @returns {Promise<void>}
   */
  async _replaceFromFile() {
    const img = await pickLocalImage();
    if (!img || !this.view) return;
    if (this.view.loadImageAsPixelArt(img, { fromUser: true })?.refused) return;
    this._frameLoadedArt();
  }

  /* -------------------------------------------- */

  /**
   * Pad the loaded art out to the full grid, then frame it.
   *
   * Padding first makes the whole canvas paintable, not only the pixels the source happened to cover.
   *
   * The fit waits a frame because the mount is sized on the next animation frame, so on a first load its display
   * size isn't known yet.
   */
  _frameLoadedArt() {
    const view = this.view;
    if (!view) return;
    view.expandLayerToWorkspace();
    // A 0.2 fill leaves plenty of paintable space around the sprite.
    requestAnimationFrame(() => { try { view.fitViewToContent(0.2); } catch (_) {
      notify.failure('_frameLoadedArt failed', _);
    } });
  }

  /* -------------------------------------------- */
  /*  Saving                                      */
  /* -------------------------------------------- */

  /**
   * Flatten the canvas and encode it, cropped to every pixel that isn't fully transparent.
   *
   * It's cropped because the canvas is padded out past the art, so saving it whole would give every item's icon a
   * transparent margin. Translucent pixels count as art, so soft shadows and anti-aliased rims survive the crop.
   * It throws when the pixels can't be read, as with art from a host that sends no CORS headers.
   * @returns {Promise<Blob|null>}          Null, with a notification, when there is nothing to save.
   */
  async _exportBlob() {
    const view = this.view;
    if (!view) return null;
    if (!view.layers.length) { notify.warn('Nothing to save.'); return null; }
    const canvas = view.exportToCanvas(view.size);
    const cropped = pixelArtCropTransparent(canvas, 1);
    return new Promise((resolve, reject) =>
      cropped.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'));
  }

  /* -------------------------------------------- */

  /**
   * Whether this item can be written to at all.
   *
   * Checked before the art is flattened and encoded, so a locked compendium is refused before any of that work.
   * @returns {boolean}
   */
  _canWriteItem() {
    const item = this.item;
    if (!item) {
      notify.warn('No item is bound to this studio.');
      return false;
    }
    if (!item.isOwner) {
      notify.warn(`No permission to edit ${item.name}.`);
      return false;
    }
    const pack = item.pack ? game.packs.get(item.pack) : null;
    if (pack?.locked) {
      notify.warn(`${pack.title ?? item.pack} is locked: unlock the compendium first.`);
      return false;
    }
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Save into the world and point the item at it.
   *
   * The file is named after the item, and the folder is created before the name is chosen because the name is
   * settled against what that folder already holds.
   * @returns {Promise<void>}
   */
  async _saveArt() {
    if (!this._canWriteItem()) return;
    const item = this.item;
    const folder = itemArtFolder();
    try {
      const blob = await this._exportBlob();
      if (!blob) return;
      await ensureFolderHierarchy(folder);
      const filename = await itemArtFilename(item, folder);
      const path = await uploadBlob(folder, filename, blob);
      await item.update(savedArtUpdate(path));
    } catch (e) {
      notify.failure('Item art save failed.', e);
      return;
    }
    notify.info(`Saved art for ${item.name}.`);
    this.close();
  }

  /* -------------------------------------------- */

  /**
   * Save into the Emblem RPG Content module's asset tree (`itemPackedAssetFolder` in editor/io.mjs), beside the
   * bundled art. The button shows only in Developer Mode.
   *
   * The user confirms first, and the prompt names the exact destination and the package, because this overwrites
   * compendium source.
   * @returns {Promise<void>}
   */
  async _saveArtToRoot() {
    if (!this._canWriteItem()) return;
    const item = this.item;
    let blob;
    try { blob = await this._exportBlob(); } catch (e) {
      notify.failure('Save to Studio assets failed.', e);
      return;
    }
    if (!blob) return;

    const folder = itemPackedAssetFolder(item);
    const filename = itemPackedAssetFilename(item);
    const dest = `${folder}/${filename}`;
    const safeName = foundry.utils.escapeHTML(item.name);

    const pkg = foundry.utils.escapeHTML(packedAssetPackageLabel());

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Save To Package Assets', icon: 'fas fa-box-archive' },
      content: `<p>Save packed-content art for <strong>${safeName}</strong> to:</p>`
        + `<p style="margin:.25rem 0;"><code>${dest}</code></p>`
        + `<p style="opacity:.75;font-size:.9em;">This writes into <strong>${pkg}</strong>'s shipped asset tree (compendium source) and overwrites any existing file of that name.</p>`,
      modal: true,
      rejectClose: false
    });
    if (!confirmed) return;

    try {
      await ensureFolderHierarchy(folder);
      const path = await uploadBlob(folder, filename, blob);
      await item.update(savedArtUpdate(path));
    } catch (e) {
      notify.failure('Save to Studio assets failed.', e);
      return;
    }
    notify.info(`Saved ${item.name} to ${folder}.`);
    this.close();
  }

  /* -------------------------------------------- */
  /*  Trays                                       */
  /* -------------------------------------------- */

  /**
   * Reflect the open tray into the rail.
   *
   * Leaving the adjustment tray discards any unapplied preview, since a preview the user can't see or cancel would
   * otherwise stay on the canvas until something else cleared it.
   *
   * The window is built wide enough for a tray and never resizes, since one tray is always open.
   */
  _applyTray() {
    const side = this.element?.querySelector('.fecc-side[data-fecc-side="item"]');
    if (!side) return;
    const key = this._activeTray;
    if (key !== 'adjust') this._discardAdjust();

    side.classList.add('is-expanded');
    side.querySelectorAll('.fecc-rail-tab').forEach(b => b.classList.toggle('is-active', b.dataset.feccTab === key));
    side.querySelectorAll('.fecc-side-pane').forEach(p => p.classList.toggle('is-active', p.dataset.feccPane === key));

    if (key === 'colour') {
      this._ensureColourPanel();
      const layer = this.view?.selectedLayer ?? this.view?.layers[0] ?? null;
      this._colourPanel?.setActivePalette(null, null, layer);
    } else if (key === 'adjust') {
      this._syncAdjustEnabled();
    }
  }

  /* -------------------------------------------- */
  /*  Adjustments                                 */
  /* -------------------------------------------- */

  /**
   * Wire the adjustment sliders, once.
   * @param {HTMLElement} root      Window root.
   */
  _wireAdjustments(root) {
    if (this._adjustWired) return;
    const side = root.querySelector('.fecc-side[data-fecc-side="item"]');
    if (!side) return;
    this._adjustWired = true;
    side.querySelectorAll('[data-adj]').forEach(inp => {
      inp.addEventListener('input', () => this._onAdjustInput());
    });
  }

  /* -------------------------------------------- */

  /**
   * The current slider values.
   * @returns {object}
   */
  _readAdjust() {
    const side = this.element?.querySelector('.fecc-side[data-fecc-side="item"]');
    const get = (k) => Number(side?.querySelector(`[data-adj="${k}"]`)?.value || 0);
    return { hue: get('hue'), sat: get('sat'), bright: get('bright'), contrast: get('contrast') };
  }

  /* -------------------------------------------- */

  /**
   * Return every slider to neutral.
   */
  _resetAdjustSliders() {
    this.element?.querySelectorAll('[data-adj]').forEach(inp => { inp.value = '0'; });
  }

  /* -------------------------------------------- */

  /**
   * Preview the adjustment live as a slider moves.
   *
   * The first movement begins a session, which captures the baseline pixels. Every later preview re-applies from
   * that baseline instead of stacking, so a slider can be dragged back and forth without degrading the image. The
   * session covers the selected pixels, or the whole image when nothing is selected, so an adjustment never needs a
   * selection first.
   */
  _onAdjustInput() {
    if (this._activeTray !== 'adjust') return;
    if (!this.view?.hasAdjustSession() && !this.view?.beginSelectionAdjust()) return;
    this.view.previewSelectionAdjust(this._readAdjust());
  }

  /* -------------------------------------------- */

  /**
   * Return one slider to neutral and re-preview from the baseline with the rest.
   * @param {string} key            Which slider.
   */
  _resetOneAdjust(key) {
    const inp = this.element?.querySelector(`[data-adj="${key}"]`);
    if (!inp || inp.disabled) return;
    inp.value = '0';
    if (this.view?.hasAdjustSession()) this.view.previewSelectionAdjust(this._readAdjust());
  }

  /* -------------------------------------------- */

  /**
   * Bake the preview as one undoable edit.
   *
   * The sliders are reset afterwards so further tweaks start from the new state, and any selection is kept, so a
   * region can be adjusted repeatedly without reselecting it.
   */
  _applyAdjust() {
    if (!this.view?.hasAdjustSession()) return;
    this._adjustBusy = true;
    this.view.commitSelectionAdjust();
    this._resetAdjustSliders();
    this._adjustBusy = false;
    this._syncAdjustEnabled();
  }

  /* -------------------------------------------- */

  /**
   * Discard the preview, drop any selection, and reset the sliders.
   */
  _cancelAdjust() {
    this._adjustBusy = true;
    this.view?.revertSelectionAdjust();
    this.view?.clearSelection();
    this._resetAdjustSliders();
    this._adjustBusy = false;
    this._syncAdjustEnabled();
  }

  /* -------------------------------------------- */

  /**
   * Drop an unapplied preview without touching the selection, for a tray switch.
   */
  _discardAdjust() {
    if (!this.view?.hasAdjustSession()) return;
    this._adjustBusy = true;
    this.view.revertSelectionAdjust();
    this._resetAdjustSliders();
    this._adjustBusy = false;
  }

  /* -------------------------------------------- */

  /**
   * Discard a preview whose selection has changed underneath it.
   *
   * A selection made during a whole-image preview changes what the session covers, so the preview goes the same way
   * as one whose selection moved. Guarded against re-entrancy, because applying and cancelling both change the
   * selection themselves and would otherwise re-enter this and revert what they just did.
   */
  _onSelectionChangedForAdjust() {
    if (this._adjustBusy) return;
    if (this._activeTray !== 'adjust') return;
    if (this.view?.hasAdjustSession()) {
      this.view.revertSelectionAdjust();
      this._resetAdjustSliders();
    }
    this._syncAdjustEnabled();
  }

  /* -------------------------------------------- */

  /**
   * Enable the sliders and buttons while the tray is open and there is something to adjust.
   */
  _syncAdjustEnabled() {
    const side = this.element?.querySelector('.fecc-side[data-fecc-side="item"]');
    if (!side) return;
    const enabled = this._activeTray === 'adjust' && !!this.view?.canAdjust();
    side.querySelectorAll('[data-adj]').forEach(inp => { inp.disabled = !enabled; });
    side.querySelectorAll('[data-action="adjustApply"], [data-action="adjustCancel"], [data-action="adjustReset"]')
      .forEach(b => { b.disabled = !enabled; });
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Tear down the canvas, the tray and the hook.
   *
   * Each step is isolated, so a failure in one still releases the others.
   * @returns {*}
   */
  _onClose(options) {
    try { this.view?.destroy(); } catch (_) {
      notify.failure('_onClose failed', _);
    }
    this.view = null;
    try { this._colourPanel?.destroy(); } catch (_) {
      notify.failure('_onClose failed', _);
    }
    this._colourPanel = null;
    return super._onClose(options);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onSave()     { return this._saveArt(); }
  /* -------------------------------------------- */

  static #onSaveRoot() { return this._saveArtToRoot(); }
  /* -------------------------------------------- */

  static #onCancel()   { return this.close(); }
  /* -------------------------------------------- */

  static #onImport() { return this._replaceFromFile(); }
  /* -------------------------------------------- */

  static #onClear()  { this.view?.clearLayers(); }
  /* -------------------------------------------- */

  /** Switch to the tray a rail tab names. */
  static #onToggleTray(event, target) { return this.setTray(target.dataset.feccTab); }
  /* -------------------------------------------- */

  static #onAdjustApply()  { return this._applyAdjust(); }
  /* -------------------------------------------- */

  static #onAdjustCancel() { return this._cancelAdjust(); }
  /* -------------------------------------------- */

  /** Return the slider a reset button names to neutral. */
  static #onAdjustReset(event, target) { return this._resetOneAdjust(target.dataset.adjReset); }
}
