/** @layer foundry */
import { MODULE_ID, STUDIO_PUBLICATION_OPERATION } from '../constants.mjs';
import { STUDIO_ACCESS, STUDIO_REFUSALS, StudioRefusal } from '../admission.mjs';
import { createArtPublicationClient, createArtPublicationHost } from '../publication.mjs';
import { ensureFolderHierarchy, uploadBlob } from '../editor/io.mjs';
import { actorArtAccessFor, ownsActor, readTrustedAllowlist } from './access.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Host Publication                            */
/* -------------------------------------------- */

/**
 * Studio's socketlib channel, once registered.
 *
 * This file connects host publication (publication.mjs) to Foundry and socketlib. Studio has its own channel
 * instead of a system command because a publication writes one file and none of the game's documents, and the host
 * rechecks everything itself. It still sends to the system's command host, the single connected full Gamemaster, so
 * an Assistant GM never publishes for anyone. Routing through a system command later would replace only this file.
 * @type {object|null}
 */
let socket = null;

/* -------------------------------------------- */

/**
 * The host's publisher, bound to this world.
 * @type {ReturnType<typeof createArtPublicationHost>}
 */
const publicationHost = createArtPublicationHost({
  host: commandHost,
  processing: processingActive,
  user: id => game.users?.get?.(id) ?? null,
  allowlist: readTrustedAllowlist,
  worldActors: () => game.actors ?? [],
  worldId: () => String(game.world?.id ?? ''),
  ownsActor: (actor, user) => ownsActor(user, actor),
  ensureFolder: folder => ensureFolderHierarchy(folder),
  writeFile: (folder, filename, bytes) => uploadBlob(folder, filename, new Blob([bytes], { type: 'image/png' })),
  report: (message, error) => notify.failure(message, error, null, false)
});

/* -------------------------------------------- */

/**
 * A Trusted client's publisher, which asks the host.
 * @type {ReturnType<typeof createArtPublicationClient>}
 */
const publicationClient = createArtPublicationClient({
  host: commandHost,
  send: (hostUserId, request) => socket.executeAsUser(STUDIO_PUBLICATION_OPERATION, hostUserId, request),
  report: (message, error) => notify.failure(message, error, null, false)
});

/* -------------------------------------------- */

/**
 * Open Studio's channel and answer publications on it. Registered on `socketlib.ready` in foundry/hooks.mjs.
 * Every client registers the handler, and the handler itself refuses unless its client is the eligible host.
 */
export function registerStudioPublication() {
  if (socket || !globalThis.socketlib) return;
  socket = globalThis.socketlib.registerModule(MODULE_ID) ?? null;
  socket?.register(STUDIO_PUBLICATION_OPERATION, async function answerPublication(request) {
    return publicationHost.publish(request, this?.socketdata?.userId);
  });
}

/* -------------------------------------------- */

/**
 * Save one Actor art file the way its saver's access allows. Character Studio's save paths call it.
 *
 * Staff upload the file directly. An allowed Trusted Player's file is published through the host, which picks the
 * Actor's folder itself. Every refusal throws a StudioRefusal, which a save path reports as a plain warning while the
 * canvas and its drafts stay as they were.
 * @param {object} options
 * @param {Actor} options.actor                   Actor the art belongs to.
 * @param {string} options.folder                 Folder a staff save writes into.
 * @param {string} options.filename               File name within the Actor's folder.
 * @param {Blob} options.blob                     PNG contents.
 * @param {boolean} [options.toRoot]              Whether this is a Save To Root into a package.
 * @returns {Promise<string>}                     The stored path.
 */
export async function publishActorArtFile({ actor, folder, filename, blob, toRoot = false }) {
  if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const access = actorArtAccessFor(actor);
  if (access.access === STUDIO_ACCESS.STAFF) {
    await ensureFolderHierarchy(folder);
    if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
    const fresh = actorArtAccessFor(actor);
    if (fresh.access !== STUDIO_ACCESS.STAFF) throw new StudioRefusal(STUDIO_REFUSALS.REVOKED);
    return uploadBlob(folder, filename, blob);
  }
  if (access.access === STUDIO_ACCESS.DENIED) throw new StudioRefusal(access.code);
  if (toRoot) throw new StudioRefusal(STUDIO_REFUSALS.STAFF_ONLY, 'Save To Root');
  if (!socket) {
    notify.failure('Studio publication has no socket; check that socketlib is active and the world was relaunched.');
    throw new StudioRefusal(STUDIO_REFUSALS.NO_HOST);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const outcome = await publicationClient.publish({ actorUuid: actor.uuid, filename, bytes });
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return outcome.data.path;
}

/* -------------------------------------------- */

/**
 * Whether a system command is still resolving, read from the same processing snapshot the system's input guards
 * use. publishActorArtFile and the publication host refuse a save while one is.
 */
function processingActive() {
  return game.emblemRpg?.api?.protocol?.execution?.()?.owner != null;
}

/**
 * The system's command host as this client sees it.
 * @returns {{state: string, hostUserId: string, localIsHost: boolean}}
 */
function commandHost() {
  return game.emblemRpg.api.protocol.host();
}
