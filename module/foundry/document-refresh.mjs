// @ts-check
/** @layer foundry */
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Document Refresh                            */
/* -------------------------------------------- */

/**
 * Show newly saved token art without a reload: the system's `presentation.tokenArt.refresh` redraws the actor's
 * tokens and its Control Panel, then the sheet re-renders and each placed token refreshes. Called by Character
 * Studio after a token save or clear.
 */
export async function refreshActorTokenArt(actor) {
  const refresh = game.emblemRpg?.api?.presentation?.tokenArt?.refresh;
  if (typeof refresh === 'function') {
    try { await refresh(actor.uuid, { force: true }); } catch (_) {
      notify.failure('refreshActorTokenArt failed', _);
    }
  }
  try { actor.sheet?.render?.(false); } catch (_) {
    notify.failure('refreshActorTokenArt failed', _);
  }
  for (const token of actor.getActiveTokens?.() ?? []) {
    try { token.renderFlags?.set?.({ refresh: true, refreshShape: true }); } catch (_) {
      notify.failure('refreshActorTokenArt failed', _);
    }
  }
  return undefined;
}

/**
 * Ask the system to redraw the actor's open Control Panel after an avatar save. Returns whether it did.
 */
export function refreshActorAuthoringPanel(actor) {
  const refresh = game.emblemRpg?.api?.presentation?.tokenArt?.refreshAuthoringPanel;
  if (typeof refresh !== 'function') return false;
  try { return refresh(actor.uuid) === true; } catch (_) {
    notify.failure('refreshActorAuthoringPanel failed', _);
    return false;
  }
}

/**
 * Open the Actor Control Panel for an actor, from Character Studio's Control Panel header button.
 *
 * The system exposes the panel only as the character sheet's `openControlPanel` header action, so that handler is
 * run against the sheet instance, which need not be rendered. A sheet without the action opens itself instead.
 * @param {Actor} actor
 * @returns {*}
 */
export function openActorConfiguration(actor) {
  const sheet = actor.sheet;
  const openPanel = sheet?.options?.actions?.openControlPanel;
  const handler = typeof openPanel === 'function' ? openPanel : openPanel?.handler;
  if (typeof handler === 'function') {
    try {
      const panel = handler.call(sheet);
      if (panel) return panel;
      notify.warn('You may not open the Control Panel for ' + actor.name + '.');
      return null;
    } catch (_) {
      notify.failure('openActorConfiguration failed', _);
    }
  }
  return sheet?.render?.({ force: true });
}
