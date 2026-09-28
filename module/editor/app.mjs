// @ts-check
/** @layer editor */

import { createStudioNotifier } from '../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* -------------------------------------------- */
/*  Shared Application                          */
/* -------------------------------------------- */
/**
 * The ApplicationV2 base for Studio windows, extended by EmblemSpriteStudio (sprite/sprite-studio.mjs). `open`
 * brings an already open window with the same `_instanceKey` to the front instead of opening a second one. The base
 * also builds the "Title: subject" window title and removes the Hooks registered through `_onHook` on close.
 */
export class EmblemStudioApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static TITLE = '';
  static TRAY_KEYS = null;

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */
  static _instanceKey(..._args) {
    return null;
  }

  static getInstance(...args) {
    const key = this._instanceKey(...args);
    if (key === null) return null;
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof this && app._openKey === key) return app;
    }
    return null;
  }

  static _create(...args) {
    return new this(...args);
  }

  static open(...args) {
    const existing = this.getInstance(...args);
    if (existing) {
      try { existing.bringToFront(); } catch (_) {
        notify.failure('open failed', _);
      }
      return existing;
    }
    const app = this._create(...args);
    app._openKey = this._instanceKey(...args);
    app.render({ force: true });
    return app;
  }

  /* -------------------------------------------- */
  /*  Construction                               */
  /* -------------------------------------------- */
  constructor(options = {}) {
    super(options);
    this._openKey = null;
    this._activeTray = this.constructor.TRAY_KEYS?.[0] ?? null;
    this._hooks = [];
  }

  /* -------------------------------------------- */
  /*  Title                                       */
  /* -------------------------------------------- */
  _titleBase() {
    return this.constructor.TITLE || super.title;
  }

  _titleSubject() {
    return null;
  }

  get title() {
    const subject = this._titleSubject();
    const base = this._titleBase();
    return subject ? `${base}: ${subject}` : base;
  }

  /* -------------------------------------------- */
  /*  Trays                                       */
  /* -------------------------------------------- */
  setTray(key) {
    const allowed = this.constructor.TRAY_KEYS;
    if (!key || (allowed && !allowed.includes(key)) || key === this._activeTray) return false;
    this._activeTray = key;
    this._applyTray?.();
    return true;
  }

  /* -------------------------------------------- */
  /*  Scoped Hooks                                */
  /* -------------------------------------------- */
  _onHook(hook, fn) {
    const id = Hooks.on(hook, fn);
    this._hooks.push([hook, id]);
    return id;
  }

  async close(options = {}) {
    for (const [hook, id] of this._hooks) Hooks.off(hook, id);
    this._hooks = [];
    return super.close(options);
  }
}

export { EmblemStudioApp as EmblemApp };
