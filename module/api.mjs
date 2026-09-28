// @ts-check
/** @layer studio */
import { EmblemCharacterStudio } from './character/character-studio.mjs';
import { EmblemSpriteStudio } from './sprite/sprite-studio.mjs';
import { seedCompositionsFromDefault } from './character/variants.mjs';
import { runSceneCrop } from './editor/scene-crop.mjs';
import { createStudioNotifier } from './foundry/notify.mjs';
import { slugifyHyphen } from './utils/string.mjs';
import { MODULE_ID } from './constants.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Studio API                                  */
/* -------------------------------------------- */

/**
 * Open Character Studio, on one of an actor's art destinations when an actor is given. The system's
 * `openStudioForSlot` (external/studio/character-art.mjs) calls it from the Actor Control Panel and the container
 * sheets, and the scene control button calls it with no actor.
 * @param {Actor|null} [actor]
 * @param {object|null} [tuple] The class, entry and type to open a tab on.
 * @returns {Promise<EmblemCharacterStudio|null>} null if the user or the actor is refused.
 */
export function openCharacterStudio(actor = null, tuple = null) {
  if (actor) return EmblemCharacterStudio.openForField(actor, tuple);
  return EmblemCharacterStudio.open();
}

/** Open Sprite Studio on an item's image. The system's `openStudioForItem` calls it from item sheets. */
export function openSpriteStudio(item) {
  return EmblemSpriteStudio.open(item);
}

/**
 * The actor update that copies the default token compositions to a new class tab. The system's
 * `studioClassSeedUpdate` asks for it, and the Actor Control Panel saves it along with the new tab.
 */
export function getCharacterClassSeed(actor, className) {
  return seedCompositionsFromDefault(actor?.getFlag?.(MODULE_ID, 'tokenComp'), className, MODULE_ID) ?? {};
}

/* -------------------------------------------- */

/**
 * Cut a region out of the scene's art and write it to one of an actor's image fields. The system's
 * `openSceneCropForArtState` calls it from the Object sheet's crop control.
 *
 * The caller supplies the field because the art states belong to the system's schema: the sheet already knows
 * which field the clicked row writes to, so Studio doesn't keep its own copy of that table.
 *
 * The written path gets a cache-busting suffix, because a re-cut writes to the same filename and nothing would
 * otherwise notice the change.
 * @param {object} options
 * @param {string} options.actorUuid               Actor whose art is being cut.
 * @param {string} options.target                  Which art state, which names the file and labels the controls.
 * @param {string} options.field                   Document path the saved path is written to.
 * @returns {Promise<string|null>}                 The written value, or null.
 */
export async function openSceneCrop({ actorUuid, target, field } = {}) {
  if (!game.user?.isGM) return null;
  if (!actorUuid || !target || typeof field !== 'string' || !field) return null;

  const actor = await fromUuid(actorUuid);
  if (actor?.documentName !== 'Actor') {
    notify.warn('That art state belongs to no actor the Studio can reach.');
    return null;
  }

  const slug = slugifyHyphen(actor.name, 'object').toLowerCase();
  const path = await runSceneCrop({
    filename: `${slug}-${actor.id}-${target}.png`,
    label: `${actor.name}: ${target}`
  });
  if (!path) return null;

  const src = `${path}?v=${Date.now()}`;
  await actor.update({ [field]: src });
  return src;
}

/** The members published as `game.modules.get('emblem-rpg-studio').api` on init (foundry/hooks.mjs). */
export function createStudioApi() {
  return Object.freeze({
    openCharacterStudio,
    openSpriteStudio,
    openSceneCrop,
    getCharacterClassSeed
  });
}
