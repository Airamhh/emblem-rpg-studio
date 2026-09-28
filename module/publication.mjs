// @ts-check
/** @layer studio */
import { STUDIO_ACCESS, STUDIO_REFUSALS, resolveActorArtAccess, resolveStudioAccess } from './admission.mjs';
import { actorArtReferences, actorUnitFolderName, comparableArtPath } from './character/variants.mjs';
import { CHARACTER_STUDIO_ACTOR_TYPES, PUBLICATION_SEGMENT_MAX, STUDIO_CHARACTER_ART_TREE } from './constants.mjs';

/* -------------------------------------------- */
/*  Bounds                                      */
/* -------------------------------------------- */

/**
 * What one host publication may carry, and how long a client waits for it.
 *
 * Token and avatar art is a few kilobytes and a spritesheet rarely more than a few hundred, so the size ceiling
 * leaves room without letting one request fill the host's memory or disk. The side ceiling matches the export
 * panel's clamp, and the response deadline matches the system's `COMMAND_TIMING.responseMs`.
 */
const ART_PUBLICATION_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDimension: 8192,
  maxFilenameLength: 128,
  responseMs: 60000
});

/** The code a publication settles with when the host wrote the file. */
const STUDIO_PUBLICATION_OUTCOMES = Object.freeze({
  PUBLISHED: 'studio.published'
});

/** A PNG's first eight bytes. */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The signature and a complete IHDR chunk, which is everything read to learn a PNG's size. */
const PNG_HEADER_BYTES = 33;

/** A world Actor's UUID. Token, compendium and embedded Actors never qualify. */
const WORLD_ACTOR_UUID = /^Actor\.([A-Za-z0-9]{16})$/;

/** A plain PNG file name: no separators, no leading dot and no empty dot runs. */
const ART_FILENAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/;

/** One folder name within a publication path. `unitFileStem` caps a unit's stem so its folder always fits. */
const PATH_SEGMENT = new RegExp(`^[A-Za-z0-9_-]{1,${PUBLICATION_SEGMENT_MAX}}$`);

/* -------------------------------------------- */
/*  Encoding                                    */
/* -------------------------------------------- */

/**
 * Encode art bytes as base64 text for the socket, since text survives any transport socketlib might use and binary
 * data isn't guaranteed to. The bytes are converted in chunks, because spreading a whole image into one call would
 * pass the argument limit.
 * @param {Uint8Array} bytes        PNG contents.
 * @returns {string}
 */
function encodeArtBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/* -------------------------------------------- */

/**
 * A PNG's declared size, read from its IHDR chunk, or null when the bytes do not begin as a PNG.
 * @param {Uint8Array} bytes        File contents.
 * @returns {{width: number, height: number}|null}
 */
function readPngDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PNG_HEADER_BYTES) return null;
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Check what a client means to publish: a world Actor, a plain PNG file name, and PNG bytes within the limits.
 * The client runs it before sending anything, for a quick answer, and the host runs it again on what arrives.
 * @param {{actorUuid?: *, filename?: *, bytes?: *}|null} intent     What to publish.
 * @returns {Readonly<{ok: boolean, code: string, data: object}>}
 */
function validateArtPublicationIntent(intent) {
  const target = targetRefusal(intent?.actorUuid, intent?.filename);
  if (target) return target;
  const bytes = intent?.bytes;
  if (!(bytes instanceof Uint8Array)) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  if (bytes.length > ART_PUBLICATION_LIMITS.maxBytes) return refusal(STUDIO_REFUSALS.TOO_LARGE);
  const size = readPngDimensions(bytes);
  if (!size) return refusal(STUDIO_REFUSALS.NOT_PNG);
  if (!withinSide(size.width) || !withinSide(size.height)) return refusal(STUDIO_REFUSALS.BAD_DIMENSIONS);
  const actorUuid = String(intent?.actorUuid);
  return accepted('', {
    actorUuid, actorId: WORLD_ACTOR_UUID.exec(actorUuid)?.[1] ?? '', filename: String(intent?.filename), bytes,
    width: size.width, height: size.height
  });
}

/* -------------------------------------------- */

/**
 * Check a publication request as it arrives over the socket, decoding its bytes only once its target is sound.
 * @param {*} request               The socket payload.
 * @returns {Readonly<{ok: boolean, code: string, data: object}>}
 */
function validateArtPublicationRequest(request) {
  if (!request || typeof request !== 'object' || typeof request.data !== 'string') {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  const target = targetRefusal(request.actorUuid, request.filename);
  if (target) return target;
  if (request.data.length > Math.ceil(ART_PUBLICATION_LIMITS.maxBytes / 3) * 4) {
    return refusal(STUDIO_REFUSALS.TOO_LARGE);
  }
  const bytes = decodeArtBytes(request.data);
  if (!bytes) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  return validateArtPublicationIntent({ actorUuid: request.actorUuid, filename: request.filename, bytes });
}

/* -------------------------------------------- */
/*  Destination                                 */
/* -------------------------------------------- */

/**
 * The host folder an Actor's published art lands in: its unit folder in this world's Character Studio tree.
 *
 * Built only from segments that hold no separator or dot, so no request can climb out of Studio's own folder.
 * @param {{worldId: *, unitFolder: *}} parts     The world id and the Actor's unit folder name.
 * @returns {string}                              The folder, or an empty string when a segment is unsafe.
 */
function artPublicationFolder({ worldId, unitFolder }) {
  const world = String(worldId ?? '');
  const unit = String(unitFolder ?? '');
  if (!PATH_SEGMENT.test(world) || !PATH_SEGMENT.test(unit)) return '';
  return `worlds/${world}/${STUDIO_CHARACTER_ART_TREE}/${unit}`;
}

/* -------------------------------------------- */

/**
 * Every art path each world Actor points at, including its prototype Token's texture.
 * @param {Iterable<object>} actors   World Actors.
 * @returns {Array<{actor: object, path: string}>}
 */
function worldArtReferences(actors) {
  const references = [];
  for (const actor of actors ?? []) {
    for (const { path } of actorArtReferences(actor)) references.push({ actor, path });
    const texture = actor?.prototypeToken?.texture?.src;
    if (typeof texture === 'string' && texture) references.push({ actor, path: texture });
  }
  return references;
}

/* -------------------------------------------- */

/**
 * The first reference to a path from art the publisher may not overwrite, or null.
 * @param {string} path                                     The destination.
 * @param {Iterable<{actor: object, path: string}>} references   Art references to check.
 * @param {(reference: {actor: object, path: string}) => boolean} mayOverwrite
 * @returns {{actor: object, path: string}|null}
 */
function findForeignArtReference(path, references, mayOverwrite) {
  const target = comparableArtPath(path);
  for (const reference of references ?? []) {
    if (comparableArtPath(reference.path) === target && !mayOverwrite(reference)) return reference;
  }
  return null;
}

/* -------------------------------------------- */
/*  Host                                        */
/* -------------------------------------------- */

/**
 * The host's side of art publication, built in foundry/publication-transport.mjs.
 *
 * It runs only on the eligible Gamemaster host and decides everything again from the socket's authenticated sender.
 * Role, allowlist and ownership are checked at the moment of writing. The file goes in the Actor's own unit folder,
 * never a folder the client names, and a Trusted Player can't overwrite a file that an Actor they don't own still
 * uses.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the command host.
 * @param {() => boolean} ports.processing                             Whether system processing blocks publication.
 * @param {(id: string) => object|null} ports.user                      A user by id.
 * @param {() => *} ports.allowlist                                     The stored allowlist.
 * @param {() => Iterable<object>} ports.worldActors                    Every world Actor.
 * @param {() => string} ports.worldId                                  This world's id.
 * @param {(actor: object, user: object) => boolean} ports.ownsActor    Whether a user owns an Actor.
 * @param {(folder: string) => Promise<void>} ports.ensureFolder        Create a folder and its parents.
 * @param {(folder: string, filename: string, bytes: Uint8Array) => Promise<string>} ports.writeFile
 * @param {(message: string, error: *) => void} ports.report            Record a diagnostic.
 * @returns {Readonly<{publish: (request: *, senderId: *) => Promise<object>}>}
 */
export function createArtPublicationHost(ports) {
  return Object.freeze({
    async publish(request, senderId) {
      try {
        return await publishOnHost(ports, request, senderId);
      } catch (error) {
        ports.report('Studio art publication failed on the host.', error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * Admit, validate, confine and write one publication.
 * @param {object} ports            See {@link createArtPublicationHost}.
 * @param {*} request               The socket payload.
 * @param {*} senderId              The authenticated sender's user id.
 * @returns {Promise<object>}
 */
async function publishOnHost(ports, request, senderId) {
  if (ports.host()?.localIsHost !== true) return refusal(STUDIO_REFUSALS.NOT_HOST);
  if (ports.processing()) return refusal(STUDIO_REFUSALS.PROCESSING);
  const sender = ports.user(String(senderId ?? ''));
  const studio = resolveStudioAccess(sender, ports.allowlist());
  if (studio.access === STUDIO_ACCESS.DENIED) return refusal(studio.code);

  const valid = validateArtPublicationRequest(request);
  if (!valid.ok) return valid;
  const actors = [...ports.worldActors()];
  const actor = actors.find(candidate => candidate?.id === valid.data.actorId);
  if (!actor || !CHARACTER_STUDIO_ACTOR_TYPES.includes(actor.type)) return refusal(STUDIO_REFUSALS.ACTOR_NOT_FOUND);
  const ownsActor = ports.ownsActor(actor, sender);
  const art = resolveActorArtAccess(sender, { allowlist: ports.allowlist(), ownsActor });
  if (art.access === STUDIO_ACCESS.DENIED) return refusal(art.code);

  const folder = artPublicationFolder({ worldId: ports.worldId(), unitFolder: actorUnitFolderName(actor, actors) });
  if (!folder) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  const path = `${folder}/${valid.data.filename}`;
  const mayOverwrite = reference => reference.actor === actor || ports.ownsActor(reference.actor, sender);
  if (art.access === STUDIO_ACCESS.TRUSTED && findForeignArtReference(path, worldArtReferences(actors), mayOverwrite)) {
    return refusal(STUDIO_REFUSALS.FOREIGN_ART);
  }

  try {
    await ports.ensureFolder(folder);
    const rechecked = recheckPublication(ports, valid.data, String(senderId ?? ''), actor, folder);
    if (rechecked) return rechecked;
    const stored = await ports.writeFile(folder, valid.data.filename, valid.data.bytes);
    return accepted(STUDIO_PUBLICATION_OUTCOMES.PUBLISHED, { path: String(stored || path).split('?')[0] });
  } catch (error) {
    ports.report(`Could not write ${path} for a Studio publication.`, error);
    return refusal(STUDIO_REFUSALS.WRITE_FAILED);
  }
}

/**
 * Repeat the host, access, Actor, folder and art-reference checks just before the write, since any of them can
 * change while the folder is being created. Returns a refusal, or null to go ahead.
 */
function recheckPublication(ports, intent, senderId, originalActor, folder) {
  if (ports.host()?.localIsHost !== true) return refusal(STUDIO_REFUSALS.NOT_HOST);
  if (ports.processing()) return refusal(STUDIO_REFUSALS.PROCESSING);
  const sender = ports.user(senderId);
  const studio = resolveStudioAccess(sender, ports.allowlist());
  if (studio.access === STUDIO_ACCESS.DENIED) return refusal(studio.code);
  const actors = [...ports.worldActors()];
  const actor = actors.find(candidate => candidate?.id === intent.actorId);
  if (!actor || actor !== originalActor) return refusal(STUDIO_REFUSALS.ACTOR_NOT_FOUND);
  const access = resolveActorArtAccess(sender, { allowlist: ports.allowlist(), ownsActor: ports.ownsActor(actor, sender) });
  if (access.access === STUDIO_ACCESS.DENIED) return refusal(access.code);
  if (folder !== artPublicationFolder({ worldId: ports.worldId(), unitFolder: actorUnitFolderName(actor, actors) })) {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  if (access.access === STUDIO_ACCESS.TRUSTED && findForeignArtReference(folder + '/' + intent.filename,
    worldArtReferences(actors), reference => reference.actor === actor || ports.ownsActor(reference.actor, sender))) {
    return refusal(STUDIO_REFUSALS.FOREIGN_ART);
  }
  return null;
}

/* -------------------------------------------- */
/*  Client                                      */
/* -------------------------------------------- */

/**
 * A Trusted client's side of art publication, built in foundry/publication-transport.mjs: validate, ask the host,
 * and settle within the deadline. A request the host hasn't answered in time settles as unknown and is never resent,
 * because the host may still be writing it. The person saving decides whether to save again.
 *
 * The host is read again in the same step that sends, since socketlib refuses to send to a user who has left, and
 * nothing sent means the art was not saved.
 * @param {object} ports
 * @param {() => {state?: string, hostUserId?: string}} ports.host             This client's view of the host.
 * @param {(hostUserId: string, request: object) => Promise<*>} ports.send     Deliver a request to the host.
 * @param {(message: string, error: *) => void} ports.report                   Record a diagnostic.
 * @returns {Readonly<{publish: (intent: object) => Promise<object>}>}
 */
export function createArtPublicationClient({ host, send, report }) {
  return Object.freeze({
    async publish(intent) {
      const target = host() ?? {};
      const states = game.emblemRpg.api.protocol.hostStates;
      if (target.state === states.MULTIPLE_HOSTS) return refusal(STUDIO_REFUSALS.MULTIPLE_HOSTS);
      if (target.state === states.DUPLICATE_PAGES) return refusal(STUDIO_REFUSALS.DUPLICATE_PAGES);
      if (target.state !== states.READY || !target.hostUserId) return refusal(STUDIO_REFUSALS.NO_HOST);
      const valid = validateArtPublicationIntent(intent);
      if (!valid.ok) return valid;
      const { actorUuid, filename, bytes } = valid.data;
      const request = { actorUuid, filename, data: encodeArtBytes(bytes) };
      return settleWithin(() => {
        const current = host() ?? {};
        if (current.state !== states.READY || current.hostUserId !== target.hostUserId) {
          return refusal(STUDIO_REFUSALS.NO_HOST);
        }
        return send(String(target.hostUserId), request);
      }, ART_PUBLICATION_LIMITS.responseMs, report);
    }
  });
}

/* -------------------------------------------- */

/**
 * The host's answer, or unknown when the request fails, the answer is malformed or the deadline passes.
 * @param {() => Promise<*>} request
 * @param {number} responseMs
 * @param {(message: string, error: *) => void} report
 * @returns {Promise<object>}
 */
async function settleWithin(request, responseMs, report) {
  let timer = null;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(refusal(STUDIO_REFUSALS.OUTCOME_UNKNOWN)), responseMs);
  });
  const answer = Promise.resolve()
    .then(request)
    .then(result => wellFormedOutcome(result) ?? refusal(STUDIO_REFUSALS.OUTCOME_UNKNOWN), error => {
      report('The host did not answer a Studio art publication.', error);
      return refusal(STUDIO_REFUSALS.OUTCOME_UNKNOWN);
    });
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------- */

/**
 * A host answer in outcome shape, or null when it is not one.
 * @param {*} result
 * @returns {Readonly<{ok: boolean, code: string, data: object}>|null}
 */
function wellFormedOutcome(result) {
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean' || typeof result.code !== 'string') {
    return null;
  }
  if (result.ok && typeof result.data?.path !== 'string') return null;
  return result.ok ? accepted(result.code, { path: result.data.path }) : refusal(result.code);
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * The refusal a target earns before any bytes are read, or null when it is sound.
 * @param {*} actorUuid
 * @param {*} filename
 * @returns {Readonly<object>|null}
 */
function targetRefusal(actorUuid, filename) {
  if (typeof actorUuid !== 'string' || !WORLD_ACTOR_UUID.test(actorUuid)) {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  if (typeof filename !== 'string' || filename.length > ART_PUBLICATION_LIMITS.maxFilenameLength
    || !ART_FILENAME.test(filename)) return refusal(STUDIO_REFUSALS.BAD_FILENAME);
  return null;
}

/* -------------------------------------------- */

/**
 * Socket text back to bytes, or null when it is not canonical base64.
 *
 * The alphabet and padding are checked first, so the browser's forgiving decoder never accepts something the
 * client would not have sent.
 * @param {string} text
 * @returns {Uint8Array|null}
 */
function decodeArtBytes(text) {
  if (text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) return null;
  const padding = text.indexOf('=');
  if (padding !== -1 && (padding < text.length - 2 || /[^=]/.test(text.slice(padding)))) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/* -------------------------------------------- */

/** Whether one side of an image is within the publication limit. */
function withinSide(side) {
  return Number.isInteger(side) && side >= 1 && side <= ART_PUBLICATION_LIMITS.maxDimension;
}

/** One frozen refusal. */
function refusal(code) {
  return Object.freeze({ ok: false, code, data: Object.freeze({}) });
}

/** One frozen acceptance. */
function accepted(code, data) {
  return Object.freeze({ ok: true, code, data: Object.freeze(data) });
}
