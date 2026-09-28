/** @layer editor */
import { STUDIO_REFUSALS, StudioRefusal } from '../admission.mjs';
import { isStudioStaff } from '../foundry/access.mjs';
import { createStudioNotifier } from '../foundry/notify.mjs';
import { loadImage } from '../utils/image.mjs';
import { slugifyUnderscore } from '../utils/string.mjs';
import {
  CONTENT_MODULE_ID, DEVELOPER_MODE_SETTING, MODULE_ID, PACKED_ASSET_ROOT, STUDIO_ASSET_ROOT, STUDIO_CHARACTER_ART_TREE
} from '../constants.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Filesystem                                  */
/* -------------------------------------------- */

/**
 * Create every missing folder along a path. It goes one segment at a time, because Foundry's createDirectory only
 * makes one level, and browses each level first so an existing folder isn't created again. A create that loses a
 * race and reports that the folder already exists is ignored, since the folder is there either way. Staff only.
 * @param {string} fullPath               Folder path to ensure.
 * @returns {Promise<void>}
 */
export async function ensureFolderHierarchy(fullPath) {
  refuseSharedWriteUnlessStaff();
  const FP = foundry.applications.apps.FilePicker.implementation;
  if (!fullPath) return;
  const segments = fullPath.split('/').filter(Boolean);
  let walked = '';
  for (const seg of segments) {
    walked = walked ? `${walked}/${seg}` : seg;
    try {
      await FP.browse('data', walked);
    } catch (diagnosticError) { notify.probe('Check folder existence', diagnosticError, /ENOENT|does not exist|no such file or directory/i.test(String(diagnosticError?.message ?? ''))); 
      try {
        await FP.createDirectory('data', walked, {});
      } catch (e) {
        notify.probe('Check folder existence', e, /EEXIST|already exists/i.test(String(e?.message ?? '')));
        if (!/EEXIST|already exists/i.test(String(e?.message ?? ''))) throw e;
      }
    }
  }
}

/* -------------------------------------------- */

/**
 * Read a JSON sidecar, or null when it is missing or unreadable. The folder is browsed before the fetch, so a
 * missing sidecar costs a listing rather than a failed request. The studio checks for several of these each time it
 * opens, and the console would otherwise fill with 404s.
 *
 * The fetch adds a cache-busting query, because a sidecar written moments ago through the upload API would
 * otherwise come back from the cache in its old state.
 * @param {string} folder                 Folder to read from.
 * @param {string} filename               Sidecar name.
 * @returns {Promise<object|null>}
 */
export async function fetchSidecarJson(folder, filename) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  if (!folder || !filename) return null;
  let listed;
  try {
    const result = await FP.browse('data', folder);
    listed = (result?.files ?? []).some(p => decodePathBasename(p) === filename);
  } catch (_) {
    notify.probe('Check optional sidecar folder', _, /ENOENT|does not exist|no such file or directory/i.test(String(_?.message ?? '')));
    return null;
  }
  if (!listed) return null;
  try {
    const res = await fetch(`${folder}/${filename}?_v=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    notify.failure('fetchSidecarJson failed', _);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Upload a blob and return where it landed. It throws on failure instead of returning an empty path, because
 * callers save art and sidecars through it, and a silent failure would leave the studio believing it had saved.
 * Staff only.
 * @param {string} folder                 Destination folder.
 * @param {string} filename               File name.
 * @param {Blob} blob                     Contents.
 * @returns {Promise<string>}             The stored path.
 */
export async function uploadBlob(folder, filename, blob) {
  refuseSharedWriteUnlessStaff();
  const FP = foundry.applications.apps.FilePicker.implementation;
  const file = new File([blob], filename, { type: blob.type });
  const result = await FP.upload('data', folder, file, {}, { notify: false });
  if (!result?.path) throw new Error(`Upload of ${filename} to ${folder} failed.`);
  return result.path;
}

/* -------------------------------------------- */

/**
 * Refuse a direct file write from anyone but staff. Only the Gamemaster and Assistant GMs write Studio's files
 * directly. A Trusted Player's art is published through the host (publication.mjs) and their drafts stay in their
 * own browser, so a direct write from them is refused with a StudioRefusal before any request is made.
 */
function refuseSharedWriteUnlessStaff() {
  if (!isStudioStaff()) throw new StudioRefusal(STUDIO_REFUSALS.STAFF_ONLY, 'save shared Studio files');
}

/* -------------------------------------------- */
/*  Serialized Sidecar Writes                   */
/* -------------------------------------------- */

/**
 * One write queue per destination path, holding the running upload and the newest payload waiting behind it.
 * @type {Map<string, object>}
 */
const sidecarWrites = new Map();

/* -------------------------------------------- */

/**
 * Save a JSON sidecar: schemas.json and the workspace (fecc-asset-schema.mjs), or a category's tabs.json
 * (fecc-custom-tabs.mjs). Writes to one path run one at a time. While one runs, only the newest payload waits, and
 * a caller whose payload was replaced by a newer one settles when that newer write finishes.
 */
export function writeSidecarJson(folder, filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  const key = `${folder}/${filename}`;
  const queue = sidecarWrites.get(key) ?? { pending: null, running: false };
  sidecarWrites.set(key, queue);
  return new Promise((resolve, reject) => {
    const waiters = queue.pending ? queue.pending.waiters : [];
    waiters.push({ resolve, reject });
    queue.pending = { json, waiters };
    if (!queue.running) _drainSidecarWrites(key, queue, folder, filename);
  });
}

/* -------------------------------------------- */

/** Write one path's queued payloads, one at a time, until nothing is waiting. */
async function _drainSidecarWrites(key, queue, folder, filename) {
  queue.running = true;
  while (queue.pending) {
    const { json, waiters } = queue.pending;
    queue.pending = null;
    try {
      const blob = new Blob([json], { type: 'application/json' });
      await ensureFolderHierarchy(folder);
      await uploadBlob(folder, filename, blob);
      for (const waiter of waiters) waiter.resolve();
    } catch (e) {
      for (const waiter of waiters) waiter.reject(e);
    }
  }
  queue.running = false;
  sidecarWrites.delete(key);
}

/* -------------------------------------------- */
/*  Image Loading                               */
/* -------------------------------------------- */

/**
 * Whether a URL can be read without cross-origin permission. A relative path is same-origin unless it starts with
 * `//`, and data and blob URLs always are.
 * @param {string} url            URL to test.
 * @returns {boolean}
 */
function isSameOriginUrl(url) {
  const raw = String(url ?? '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return !raw.startsWith('//');
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return true;
  try { return new URL(raw, window.location.href).origin === window.location.origin; }
  catch (_) {
    notify.probe('isSameOriginUrl probe', _);
    return false;
  }
}

/* -------------------------------------------- */

/**
 * Load an image, asking for cross-origin access only when the URL is on another origin, because an unneeded request
 * makes some servers refuse outright. If the cross-origin load fails, loadImage (utils/image.mjs) retries without
 * it, since an image that shows but can't have its pixels read is better than one that doesn't load.
 * @param {string} url                            Image URL.
 * @returns {Promise<HTMLImageElement>}
 */
export function downloadImage(url) {
  const sameOrigin = isSameOriginUrl(url);
  return loadImage(url, { crossOrigin: sameOrigin ? null : 'anonymous', retryWithoutCors: !sameOrigin });
}

/* -------------------------------------------- */

/**
 * Ask the user to pick an image file from their machine. The file's name without its extension is put on
 * `img.dataset.importName`, so importers can name the layer after it. Resolves null on cancel or failure.
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function pickLocalImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const base = (file.name || '').replace(/\.[^.]+$/, '').trim();
          if (base) img.dataset.importName = base;
          resolve(img);
        };
        img.onerror = () => resolve(null);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
}

/* -------------------------------------------- */

/**
 * Read an image from the system clipboard for the manual importer (fecc-import-manual.mjs), returned the same way
 * as pickLocalImage's. Each failure shows its own notice (no clipboard API, permission refused, no image on the
 * clipboard), because a paste that does nothing looks like a broken button.
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function pickClipboardImage() {
  if (!navigator.clipboard?.read) {
    notify.warn('Clipboard read is unavailable here.');
    return null;
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    notify.validation('Allow clipboard access to paste an image.', e, e?.name === 'NotAllowedError');
    return null;
  }
  for (const item of items) {
    // The type depends on what was copied and from where (a PNG screenshot, JPEG or WebP), so any image type is
    // accepted.
    const imageType = item.types.find(t => t.startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Clipboard image could not be decoded.'));
        img.src = url;
      });
    } catch (e) {
      notify.failure('pickClipboardImage failed', e);
      return null;
    } finally {
      // Safe after onload: the Image has already decoded into its own bitmap.
      URL.revokeObjectURL(url);
    }
  }
  notify.warn('No image on the clipboard.');
  return null;
}

/* -------------------------------------------- */
/*  World Folders                               */
/* -------------------------------------------- */

/*
 * Studio saves into the world's data folder, which stays writable, while installed package folders are read-only
 * during ordinary play. Everything lives under worlds/<world>/emblem/:
 *
 *   parts/<category>/    imported parts for the parts library (customTokenFolder), with a tabs.json sidecar per
 *                        category (fecc-custom-tabs.mjs)
 *   character/<unit>/    a unit's saved avatar, tokens and spritesheets (actorArtFolder)
 *   items/               item art saved from Sprite Studio (itemArtFolder)
 *   destructibles/       regions cut out of the scene (sceneCropFolder)
 *   projects/            project files, one per saved composition of a whole actor (projectFolder)
 *   export/              PNGs saved by the export panel (fecc-export-panel.mjs)
 *   meta/                schemas.json with each imported asset's default palette, and workspace-<userId>.json
 *                        with a staff user's open studio (fecc-asset-schema.mjs)
 *
 * In Developer Mode, imported templates go into the Studio module's own library instead (STUDIO_PARTS_ROOT), and
 * Save To Root writes finished art into the Content module (PACKED_ASSET_ROOT).
 */

/**
 * The token side's parts-library categories, which are also its folder names.
 * @type {string[]}
 */
export const CUSTOM_TOKEN_CATEGORIES = ['idle', 'dodge', 'attack', 'weapon', 'part', 'effect'];
/* -------------------------------------------- */

/**
 * The avatar side's parts-library categories, likewise its folder names.
 * @type {string[]}
 */
const CUSTOM_AVATAR_CATEGORIES = ['body', 'face', 'hair', 'hair-back', 'accessory'];
/* -------------------------------------------- */

/**
 * Every parts-library category, both sides.
 * @type {string[]}
 */
const CUSTOM_PART_CATEGORIES = [...CUSTOM_TOKEN_CATEGORIES, ...CUSTOM_AVATAR_CATEGORIES];

/* -------------------------------------------- */

/**
 * This world's data root.
 * @returns {string}
 */
function worldBase() {
  const worldId = game.world?.id ?? 'default';
  return `worlds/${worldId}`;
}

/* -------------------------------------------- */

/**
 * The world parts library's folder, or one category's folder inside it. A category that isn't one of the library's
 * gives the library's root.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {string}
 */
export function customTokenFolder(category = null) {
  const base = `${worldBase()}/emblem/parts`;
  if (category && CUSTOM_PART_CATEGORIES.includes(category)) {
    return `${base}/${category}`;
  }
  return base;
}

/* -------------------------------------------- */

/** The world folder one unit's saved avatar, tokens and spritesheets share. */
export function actorArtFolder(unitFolder) { return `${worldBase()}/${STUDIO_CHARACTER_ART_TREE}/${unitFolder}`; }

/* -------------------------------------------- */

/**
 * Where Sprite Studio saves item art in the world.
 * @returns {string}
 */
export function itemArtFolder() { return `${worldBase()}/emblem/items`; }

/* -------------------------------------------- */

/**
 * The filename for an item's art in the world: its name, made filename-safe. An item keeps the plain name when the
 * file is new or already its own, and no other item references it. Otherwise the last three characters of the
 * item's uuid are added, which tells two items with the same name apart without a whole id in every filename. Item
 * art is never shared: a duplicate, a copy on an actor or a compendium import holding the same file gets its own,
 * so saving one never repaints the others. If another item already references the suffixed name too, the tail
 * grows one character at a time until it is free. An item already holding one of these names, with no other item
 * referencing it, keeps it, so its file doesn't move to a shorter name once the copy that forced it is gone.
 * @param {Item} item                     Item being saved.
 * @param {string} [folder]               Folder the art lands in, listed to find the names already taken.
 * @returns {Promise<string>}
 */
export async function itemArtFilename(item, folder = itemArtFolder()) {
  const slug = slugifyUnderscore(item?.name, 'item');
  const plain = `${slug}.png`;
  const taken = await listFilenames(folder);
  const others = otherItemArtPaths(item);
  const free = (filename) => !others.has(comparableItemArtPath(`${folder}/${filename}`));
  const tail = String(item?.uuid ?? item?.id ?? '').replace(/[^A-Za-z0-9_]+/g, '');
  const suffixed = [];
  for (let length = Math.min(3, tail.length); length <= tail.length && tail; length++) {
    suffixed.push(`${slug}-${tail.slice(-length)}.png`);
  }
  const held = [plain, ...suffixed].find(name => itemHoldsArtFile(item, folder, name) && free(name));
  if (held) return held;
  if (!taken.has(plain) && free(plain)) return plain;
  if (!tail) return plain;
  return suffixed.find(free) ?? suffixed.at(-1);
}

/* -------------------------------------------- */

/**
 * The decoded filenames in a folder. A folder that doesn't exist yet counts as empty, since the first save into a
 * new world creates it.
 * @param {string} folder                 Folder to list.
 * @returns {Promise<Set<string>>}
 */
async function listFilenames(folder) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  if (!folder) return new Set();
  try {
    const result = await FP.browse('data', folder);
    return new Set((result?.files ?? []).map(decodePathBasename));
  } catch (e) {
    notify.probe('Check item art folder', e, /ENOENT|does not exist|no such file or directory/i.test(String(e?.message ?? '')));
    return new Set();
  }
}

/* -------------------------------------------- */

/**
 * Whether the item's art is already this file, so saving again may overwrite it. The whole path is compared, not
 * just the filename, because shipped package art and world art can share a name.
 * @param {Item} item                     Item being saved.
 * @param {string} folder                 Folder the art lands in.
 * @param {string} filename               Filename being claimed.
 * @returns {boolean}
 */
function itemHoldsArtFile(item, folder, filename) {
  const held = comparableItemArtPath(item?.img);
  return !!held && held === comparableItemArtPath(`${folder}/${filename}`);
}

/* -------------------------------------------- */

/**
 * The art paths every item other than this one references: world Items, Items on world Actors, and the entries of
 * Item compendiums, whose index already carries `img` so nothing extra is loaded.
 * @param {Item} item                     Item being saved, left out of the set.
 * @returns {Set<string>}                 Comparable paths.
 */
function otherItemArtPaths(item) {
  const paths = new Set();
  const own = item?.uuid || null;
  const add = (other) => {
    if (!other || other === item || (own && other.uuid === own)) return;
    const path = comparableItemArtPath(other.img);
    if (path) paths.add(path);
  };
  const g = globalThis.game;
  for (const other of g?.items ?? []) add(other);
  for (const actor of g?.actors ?? []) for (const other of actor?.items ?? []) add(other);
  for (const pack of g?.packs ?? []) {
    if (pack?.documentName !== 'Item') continue;
    for (const entry of pack.index ?? []) add(entry);
  }
  return paths;
}

/* -------------------------------------------- */

/**
 * An art path in the form two references to one file share: without a query, URL-decoded and lowercased, since
 * a Windows host treats paths that differ only in case as one file.
 * @param {string} path                   Stored path.
 * @returns {string}                      Comparable path, or '' for none.
 */
function comparableItemArtPath(path) {
  const raw = String(path ?? '').split('?')[0];
  if (!raw) return '';
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) { notify.probe('Decode item art path', _); }
  return decoded.toLowerCase();
}

/* -------------------------------------------- */

/**
 * Where the scene cut tool (scene-crop.mjs) saves the regions it cuts for the Object sheet. The folder keeps the
 * name `destructibles`, since existing worlds already have cuts saved there.
 * @returns {string}
 */
export function sceneCropFolder() { return `${worldBase()}/emblem/destructibles`; }

/* -------------------------------------------- */
/*  Developer Mode                              */
/* -------------------------------------------- */

/**
 * Whether Developer Mode is on. It sends imported templates into the Studio module's own parts library and shows the
 * Save To Root buttons, which write finished art into the Content module. It is always off for anyone but staff,
 * since it is a client setting anyone can tick and both of its targets are shipped package folders.
 * @returns {boolean}
 */
export function developerMode() {
  if (!isStudioStaff()) return false;
  try { return game.settings.get(MODULE_ID, DEVELOPER_MODE_SETTING) === true; }
  catch (_) {
    notify.probe('developerMode failed', _, globalThis.game?.ready !== true && /is not a registered game setting$/.test(String(_?.message ?? '')));
    return false;
  }
}

/* -------------------------------------------- */

/**
 * The inline style that hides a Save To Root button outside Developer Mode, for Character Studio's pane markup.
 * It is inline rather than a `hidden` attribute, because the button's class rule sets a display that would win.
 * @returns {string}
 */
export function saveToRootStyleAttr() {
  return developerMode() ? '' : ' style="display:none"';
}

/* -------------------------------------------- */

/**
 * Show or hide every Save To Root button in a subtree. The studios call it from the Developer Mode hook, so an open
 * studio follows the setting without a re-render that would lose what is on its canvas.
 * @param {HTMLElement} root              Subtree to update.
 * @param {boolean} [on]                  Whether the mode is on.
 */
export function syncSaveToRootVisibility(root, on = developerMode()) {
  root?.querySelectorAll?.('[data-action="saveToRoot"]')
    .forEach(btn => { btn.style.display = on ? '' : 'none'; });
}

/* -------------------------------------------- */

/**
 * The Content module's title, which the Save To Root confirm dialogs name as the destination.
 * @returns {string}
 */
export function packedAssetPackageLabel() {
  return game.modules.get(CONTENT_MODULE_ID)?.title ?? 'Emblem RPG Content';
}

/* -------------------------------------------- */
/*  Asset Paths                                 */
/* -------------------------------------------- */

/**
 * Weapon families and their asset folders.
 * @type {Object<string, string>}
 */
const WEAPON_FAMILY_FOLDER = {
  blade: 'blades', bow: 'bows', heavy: 'heavy',
  polearm: 'polearms', brawling: 'brawling', covert: 'covert'
};
/* -------------------------------------------- */

/**
 * Spell schools and their asset folders.
 * @type {Object<string, string>}
 */
const SPELL_SCHOOL_FOLDER = {
  divine: 'divine', elemental: 'elemental', arcane: 'arcane', occult: 'occult'
};
/* -------------------------------------------- */

/**
 * Consumable kinds and their asset folders.
 * @type {Object<string, string>}
 */
const CONSUMABLE_KIND_FOLDER = {
  potion: 'potions', bomb: 'bombs', booster: 'boosters', promotion: 'promotions'
};

/* -------------------------------------------- */

/**
 * The subfolder of the Content module's assets that an item's art belongs in, matching where the shipped art
 * already is. It comes from the document type and item type. The weapon family and spell school come from the
 * weapon requirement (`system.weapon.req`), which is where an item records them.
 * @param {Item} item             Item being saved.
 * @returns {string}
 */
function itemPackedAssetSubfolder(item) {
  const sys = item?.system ?? {};
  const itemType = String(sys.itemType ?? '');
  const req = String(sys.weapon?.req ?? '').trim().toLowerCase();
  switch (item?.type) {
    case 'Spell':
      return SPELL_SCHOOL_FOLDER[req] ? `spells/${SPELL_SCHOOL_FOLDER[req]}` : 'spells';
    case 'Ability':
      if (itemType === 'Active') return 'abilities/active';
      if (itemType === 'Passive') return 'abilities/passive';
      if (itemType === 'Weapon Art') return 'abilities/weapon-arts';
      if (itemType === 'Mount') return 'abilities/mounts';
      return 'abilities';
    case 'Equipment':
      if (itemType === 'Armor') return 'items/armor';
      if (itemType === 'Shield') return 'items/shields';
      if (itemType === 'Accessory') return 'items/accessories';
      if (itemType.startsWith('Staff')) return 'items/weapons/staves';
      if (itemType === 'Weapon')
        return WEAPON_FAMILY_FOLDER[req] ? `items/weapons/${WEAPON_FAMILY_FOLDER[req]}` : 'items/weapons';
      return 'items';
    case 'Consumable':
      return CONSUMABLE_KIND_FOLDER[itemType.toLowerCase()]
        ? `items/consumables/${CONSUMABLE_KIND_FOLDER[itemType.toLowerCase()]}`
        : 'items/consumables';
    case 'Resource': return 'items/resources';
    case 'Miscellaneous': return 'items/misc';
    case 'Class': return 'classes';
    default: return 'items';
  }
}

/* -------------------------------------------- */

/**
 * The Content module folder Save To Root writes an item's art into.
 * @param {Item} item             Item being saved.
 * @returns {string}
 */
export function itemPackedAssetFolder(item) {
  return `${PACKED_ASSET_ROOT}/${itemPackedAssetSubfolder(item)}`;
}

/* -------------------------------------------- */

/** The Content module folder Save To Root writes a unit's art into, the counterpart of `actorArtFolder`. */
export function actorPackedArtFolder(unitFolder) {
  return `${PACKED_ASSET_ROOT}/actors/${unitFolder}`;
}

/* -------------------------------------------- */

/**
 * The filename for an item's art in the Content module: its display name with the characters a filename can't hold
 * replaced by spaces. Spaces and case are kept, to match the shipped art's filenames. Leading and trailing dots are
 * removed too, so a name like `../..` can't leave a run of dots behind and write a hidden file.
 * @param {Item} item             Item being saved.
 * @returns {string}
 */
export function itemPackedAssetFilename(item) {
  const cleaned = String(item?.name ?? 'item')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  return `${cleaned || 'item'}.png`;
}

/* -------------------------------------------- */

/**
 * Where project files are saved (fecc-presets.mjs). It is one flat folder, since each project covers a whole actor:
 * every studio tab, both panes, and the class tabs and conditions behind them.
 * @returns {string}
 */
export function projectFolder() {
  return `${worldBase()}/emblem/projects`;
}

/* -------------------------------------------- */

/**
 * Where the world's schemas.json and workspace files are saved (fecc-asset-schema.mjs).
 * @returns {string}
 */
export function metaFolder() { return `${worldBase()}/emblem/meta`; }

/* -------------------------------------------- */
/*  Studio Parts Library                        */
/* -------------------------------------------- */

/**
 * The Studio module's own parts library, the tree its parts manifest indexes.
 *
 * Every shipped template lives here and Developer Mode imports write here too, so there is one shipped library
 * rather than copies spread across packages.
 * @type {string}
 */
export const STUDIO_PARTS_ROOT = `${STUDIO_ASSET_ROOT}/fecc`;

/* -------------------------------------------- */

/**
 * Where the Studio module keeps its shipped schemas.json. A world's own entries take precedence over it.
 * @returns {string}
 */
export function studioMetaFolder() { return `${STUDIO_PARTS_ROOT}/meta`; }

/* -------------------------------------------- */
/*  Listing                                     */
/* -------------------------------------------- */

/**
 * A path's filename, URL-decoded, since browse listings return them encoded.
 * @param {string} path           Path.
 * @returns {string}
 */
function decodePathBasename(path) {
  const raw = String(path).split('/').pop();
  try { return decodeURIComponent(raw); } catch (_) {
    notify.probe('decodePathBasename probe', _);
    return raw;
  }
}

/* -------------------------------------------- */

/**
 * List the PNGs in a folder as parts-library entries. If the folder can't be browsed, staff create it, so a
 * category the world has never imported into is ready for its first upload. Anyone else sees the category as empty.
 * Errors give an empty list instead of throwing, since a missing category folder is normal in a world that has
 * imported nothing.
 * @param {string} folder                         Folder to list.
 * @param {string|null} category                  Category the entries belong to.
 * @returns {Promise<object[]>}
 */
async function _listPngs(folder, category) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  let result = null;
  try {
    result = await FP.browse('data', folder);
  } catch (_) { notify.probe('Check optional image folder', _, /ENOENT|does not exist|no such file or directory/i.test(String(_?.message ?? ''))); 
    if (!isStudioStaff()) return [];
    await ensureFolderHierarchy(folder).catch((diagnosticError) => { notify.failure('_listPngs failed', diagnosticError); });
    try { result = await FP.browse('data', folder); } catch (_) {
      notify.failure('_listPngs failed', _);
      return [];
    }
  }
  return (result?.files ?? [])
    .filter(p => p.toLowerCase().endsWith('.png'))
    .map(path => {
      const name = decodePathBasename(path).replace(/\.png$/i, '');
      return { name, file: path, url: path, custom: true, category };
    });
}

/* -------------------------------------------- */

/**
 * The world parts library's entries for a category, for the parts library panel (fecc-parts-library.mjs). These are
 * only the world's own imports. Shipped templates come from the Studio module's parts manifest instead.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {Promise<object[]>}
 */
export async function listCustomTokens(category = null) {
  return _listPngs(customTokenFolder(category), category);
}

/* -------------------------------------------- */

/**
 * The next free auto-generated part name in a category, one past the highest already used.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {Promise<string>}
 */
export async function nextCustomTokenName(category = null) {
  const existing = await listCustomTokens(category);
  let max = 0;
  for (const e of existing) {
    const m = /^custom_asset(\d+)$/.exec(e.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `custom_asset${max + 1}`;
}
