// @ts-check
/** @layer studio */

/* -------------------------------------------- */
/*  Package Identity                            */
/* -------------------------------------------- */
export const MODULE_ID = 'emblem-rpg-studio';
const MODULE_PATH = `modules/${MODULE_ID}`;
export const STUDIO_ASSET_ROOT = `${MODULE_PATH}/assets`;

/* -------------------------------------------- */
/*  Host System Vocabulary                      */
/* -------------------------------------------- */

/*
 * Values Studio must match in Emblem RPG that the system doesn't publish. Studio reads the ones it does publish
 * from `game.emblemRpg.api` where it uses them.
 */

/** The host system's package id, and the flag scope its sheets read. Owned by `contracts/protocol.mjs`. */
export const SYSTEM_ID = 'emblem-rpg';

/** Foundry document id length, which `unitFolderName` appends to a unit's stem when two units collide. */
export const DOCUMENT_ID_LENGTH = 16;

/** The longest folder name one publication path segment may carry, enforced by `PATH_SEGMENT` in `publication.mjs`. */
export const PUBLICATION_SEGMENT_MAX = 128;

/* -------------------------------------------- */
/*  Studio Rendering                            */
/* -------------------------------------------- */
export const TOKEN_BASE_MAGNIFICATION = 2;
export const CHARACTER_STUDIO_TEMPLATE = `${MODULE_PATH}/templates/character-studio.hbs`;
export const SPRITE_STUDIO_TEMPLATE = `${MODULE_PATH}/templates/sprite-studio.hbs`;
export const STUDIO_ACCESS_TEMPLATE = `${MODULE_PATH}/templates/studio-access.hbs`;

/* -------------------------------------------- */
/*  Character Studio Actors                     */
/* -------------------------------------------- */
export const CHARACTER_STUDIO_ACTOR_TYPES = Object.freeze(['Character', 'Vendor', 'Convoy']);
export const STUDIO_CHARACTER_ART_TREE = 'emblem/character';

/* -------------------------------------------- */
/*  Studio World Folders                        */
/* -------------------------------------------- */

/**
 * Studio's other folders under a world's data root. editor/io.mjs builds its paths from these, and the publication
 * host (publication.mjs) builds the exact folders it will write into from the same names.
 */
export const STUDIO_WORLD_FOLDERS = Object.freeze({
  parts: 'emblem/parts',
  items: 'emblem/items',
  projects: 'emblem/projects',
  meta: 'emblem/meta',
  export: 'emblem/export'
});

/** The token side's parts-library categories, which are also its folder names. */
export const STUDIO_TOKEN_PART_CATEGORIES = Object.freeze(['idle', 'dodge', 'attack', 'weapon', 'part', 'effect']);

/** The avatar side's parts-library categories, likewise its folder names. */
export const STUDIO_AVATAR_PART_CATEGORIES = Object.freeze(['body', 'face', 'hair', 'hair-back', 'accessory']);

/* -------------------------------------------- */
/*  Studio Access                               */
/* -------------------------------------------- */
export const TRUSTED_ALLOWLIST_SETTING = 'trustedAllowlist';
export const STUDIO_ACCESS_MENU = 'trustedAccess';
export const STUDIO_ACCESS_HOOK = 'emblemRpgStudioAccessChanged';
export const STUDIO_PUBLICATION_OPERATION = 'art.publish.v1';
export const STUDIO_FILE_WRITE_OPERATION = 'files.write.v1';
export const STUDIO_FILE_LIST_OPERATION = 'files.list.v1';
export const STUDIO_ITEM_ART_OPERATION = 'item-art.publish.v1';
