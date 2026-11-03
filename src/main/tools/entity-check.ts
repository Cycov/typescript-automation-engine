/**
 * Finds entity ids in code that Home Assistant does not know (typos), with a
 * "did you mean" suggestion. Used by type_check; the editor runs the same rules.
 */

/** A string literal that looks like an entity id: domain.object_id */
export const ENTITY_ID_PATTERN = /^([a-z_][a-z0-9_]*)\.([a-z0-9_]+)$/;
const MAX_SUGGESTION_DISTANCE_MIN = 3;
const SUGGESTION_DISTANCE_RATIO = 4; //< allow one edit per this many characters

export interface EntityCatalog {
  ids: Set<string>;
  domains: Set<string>;
  /** "domain.service" names, which look like entity ids but are not. */
  services: Set<string>;
}

export function buildEntityCatalog(entityIds: string[], services: string[]): EntityCatalog {
  return {
    ids: new Set(entityIds),
    domains: new Set(entityIds.map((id) => id.split(".")[0])),
    services: new Set(services),
  };
}

export function editDistance(left: string, right: string): number {
  const previous = new Array(right.length + 1);
  const current = new Array(right.length + 1);
  for (let iColumn = 0; iColumn <= right.length; iColumn++) previous[iColumn] = iColumn;
  for (let iRow = 1; iRow <= left.length; iRow++) {
    current[0] = iRow;
    for (let iColumn = 1; iColumn <= right.length; iColumn++) {
      const cost = left[iRow - 1] === right[iColumn - 1] ? 0 : 1;
      current[iColumn] = Math.min(previous[iColumn] + 1, current[iColumn - 1] + 1, previous[iColumn - 1] + cost);
    }
    for (let iColumn = 0; iColumn <= right.length; iColumn++) previous[iColumn] = current[iColumn];
  }
  return previous[right.length];
}

/** Closest known entity id in the same domain, if it is close enough to be a typo. */
export function suggestEntity(entityId: string, catalog: EntityCatalog): string | undefined {
  const domain = entityId.split(".")[0];
  const limit = Math.max(MAX_SUGGESTION_DISTANCE_MIN, Math.floor(entityId.length / SUGGESTION_DISTANCE_RATIO));
  let best: string | undefined;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const candidate of catalog.ids) {
    if (!candidate.startsWith(domain + ".")) continue;
    const distance = editDistance(entityId, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

/** Message for an unknown entity id, or undefined when the literal is fine. */
export function checkEntityLiteral(text: string, catalog: EntityCatalog): string | undefined {
  const match = ENTITY_ID_PATTERN.exec(text);
  if (!match) return undefined;
  if (!catalog.domains.has(match[1])) return undefined; //< not an HA domain (file names, versions, ...)
  if (catalog.ids.has(text) || catalog.services.has(text)) return undefined;
  const suggestion = suggestEntity(text, catalog);
  return `Unknown entity id '${text}'${suggestion ? ` — did you mean '${suggestion}'?` : ""}`;
}
