/** Canonical product/compatibility mode decisions for Smart-Memory runtime paths. */

export function isProductMode(settings = {}) {
  return settings?.single_extension_mode === true;
}

export function shouldInjectDirectRepair(settings = {}) {
  return !isProductMode(settings);
}
