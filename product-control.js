/**
 * Ownership guard for Product control operations.
 *
 * A reservation token belongs to exactly one operation. Invalidating the guard
 * during navigation makes every older token inert, so stale cleanup cannot
 * release a newer operation's reservation.
 */
export function createOwnedProductControl() {
  let activeToken = null;
  let generation = 0;

  return {
    reserve(identity = {}) {
      if (activeToken) return null;
      const token = Object.freeze({
        generation,
        identity: Object.freeze({ ...identity }),
        id: Symbol('product-control-reservation'),
      });
      activeToken = token;
      return token;
    },

    release(token = null) {
      if (!token || token.generation !== generation || activeToken !== token) return false;
      activeToken = null;
      return true;
    },

    invalidate() {
      activeToken = null;
      generation += 1;
    },

    isHeld() {
      return activeToken !== null;
    },

    owns(token = null) {
      return activeToken === token && token?.generation === generation;
    },
  };
}
