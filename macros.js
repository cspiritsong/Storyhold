/**
 * Storyhold - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Macro injection: registers Storyhold content as SillyTavern macros.
 *
 * Each memory tier exposes a {{smartmemory-*}} macro that injects its content
 * wherever the user places the token in a character card or instruct template.
 * Inject functions update the cache on every call so macros always return
 * fresh content without requiring a separate generation pass.
 *
 * The unified macro (smartmemory-unified) is a special case: it is only active
 * when unified injection is also on, and its content is the merged block produced
 * by injectUnified rather than a single tier. Individual tier macros are inactive
 * when unified injection is on - unified owns those tiers.
 *
 * MACRO_NAMES              - canonical macro name strings for all 11 macros
 * setMacroContent          - stores tier content in the cache (called by inject fns)
 * isMacroActive            - true when the macro should handle placement for a tier
 * registerSmartMemoryMacros - registers all 10 macros with the ST macro system at init
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { macros as stMacros } from '../../../../scripts/macros/macro-system.js';
import { MacrosParser } from '../../../../scripts/macros.js';
import { power_user } from '../../../../scripts/power-user.js';
import { MODULE_NAME } from './constants.js';

/**
 * Canonical macro names for all 11 macros (10 individual tiers + unified block).
 * These strings are what users place in character cards or instruct templates.
 */
export const MACRO_NAMES = {
  shortterm: 'smartmemory-shortterm',
  longterm: 'smartmemory-longterm',
  session: 'smartmemory-session',
  scenes: 'smartmemory-scenes',
  arcs: 'smartmemory-arcs',
  relationships: 'smartmemory-relationships',
  canon: 'smartmemory-canon',
  profiles: 'smartmemory-profiles',
  epistemic: 'smartmemory-epistemic',
  state_ledger: 'smartmemory-stateledger',
  triggered: 'smartmemory-triggered',
  unified: 'smartmemory-unified',
};

// Content cache keyed by macro name. Updated by inject functions so the macro
// handler always returns the latest formatted output without an extra model call.
const contentCache = new Map();

/**
 * Stores content in the macro cache for a given tier.
 * Called by each inject function on every path (content or clear) so the
 * macro always returns an accurate value even when the tier produces nothing.
 * @param {string} macroName - One of the MACRO_NAMES values.
 * @param {string|null} content - Formatted content string, or null/empty to clear.
 */
export function setMacroContent(macroName, content) {
  contentCache.set(macroName, content ?? '');
}

// Character card fields that ST renders through substituteParams, which resolves
// macros. These are the locations where auto-detection will find macro tokens.
const CARD_FIELDS = ['system_prompt', 'description', 'personality', 'scenario', 'mes_example'];

/**
 * Returns true when the named macro should handle prompt placement for its tier.
 *
 * Individual tier macros (shortterm, longterm, etc.) are inactive when unified
 * injection is on - unified owns all tier content and merges it into one block,
 * so individual macros would have nothing to inject.
 *
 * The unified macro is the inverse: it is only meaningful when unified injection
 * is on (otherwise it has no content to return). It lets users control where the
 * merged block appears, just like individual tier macros control per-tier placement.
 *
 * For both kinds, activation requires either macros_enabled (manual override for
 * instruct templates) or the macro token present in a character card field.
 *
 * @param {string} macroName - One of the MACRO_NAMES values.
 * @returns {boolean}
 */
export function isMacroActive(macroName) {
  const settings = extension_settings[MODULE_NAME];
  const isUnifiedMacro = macroName === MACRO_NAMES.unified;
  // The unified macro requires unified injection to be on. Force macro mode does
  // not override this - if unified injection is off there is no merged block to inject.
  if (isUnifiedMacro && !settings?.unified_injection) return false;
  // Individual tier macros are incompatible with unified injection regardless of
  // force mode - unified owns all tier content when enabled.
  if (!isUnifiedMacro && settings?.unified_injection) return false;
  // Manual override: force macro mode for all applicable macros (including unified,
  // so {{smartmemory-unified}} works in instruct templates without card auto-detection).
  if (settings?.macros_enabled) return true;
  // Auto-detection: look for the {{macro-name}} token in character card fields.
  const token = `{{${macroName}}}`;
  const context = getContext();
  const char = context.characters?.find((c) => c.name === context.name2);
  if (!char) return false;
  return CARD_FIELDS.some((f) => typeof char[f] === 'string' && char[f].includes(token));
}

/**
 * Registers all 11 Storyhold macros with the SillyTavern macro system.
 * Called once at extension load time. The cache starts empty so each macro
 * returns an empty string until the first inject call populates it.
 *
 * ST's new macro engine (experimental_macro_engine flag) uses MacroRegistry.
 * The legacy engine uses MacrosParser. We register with whichever is active,
 * mirroring the pattern used by ST's own built-in modules.
 */
export function registerSmartMemoryMacros() {
  for (const [tierKey, macroName] of Object.entries(MACRO_NAMES)) {
    if (power_user?.experimental_macro_engine) {
      stMacros.register(macroName, {
        category: stMacros.category.MISC,
        description: `Storyhold: ${tierKey} tier content`,
        returns: 'Formatted memory tier content, empty string if tier is disabled or has no data',
        handler: () => contentCache.get(macroName) ?? '',
      });
    } else {
      MacrosParser.registerMacro(
        macroName,
        () => contentCache.get(macroName) ?? '',
        `Storyhold: ${tierKey} tier content`,
      );
    }
  }
}
