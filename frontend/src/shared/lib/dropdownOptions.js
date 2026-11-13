import { useEffect, useState } from "react";
import { getBackendUrl } from "./url";

/**
 * The choices forms offer for the lists the office maintains - genders,
 * scholarship grants, modalities, and the contact lists - read from the server
 * instead of written into this bundle.
 *
 * Until 2026-09-25 the grants and genders were constants here AND in PHP AND in
 * the database's column definitions, and the Users screen kept a fourth copy
 * that had gone stale: it offered HK / City / Others, which the server
 * refuses, so no grant could be saved from that screen at all. A list edited on
 * the Dropdown Management screen now reaches every form on its next load.
 *
 * One request serves every list (dropdown_options.php, any signed-in user), and
 * the answer is shared by every component that asks, so a page with three
 * dropdowns and a filter bar still makes one call.
 *
 * Synchronous readers (getDropdownOptions / getDropdownValues) exist for code
 * that is not a component - the import row parser, the filter definitions.
 * They return [] until the first load lands; useDropdownOptions() is what
 * triggers that load and re-renders when it does.
 */

let cache = {};
let defaults = {};
let inflight = null;
const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener());
}

/**
 * Put lists in the cache - from the server, or from a test. `listDefaults` is
 * what a blank field becomes, per list (a blank modality is Flex); the server
 * declares it, so this bundle never names a value the office could rename.
 */
export function primeDropdownOptions(options, listDefaults = {}) {
  cache = { ...cache, ...(options || {}) };
  defaults = { ...defaults, ...(listDefaults || {}) };
  notify();
}

/** What a blank field of this list becomes, or null if blank stays blank. */
export function getDropdownDefault(listKey) {
  return defaults[listKey] ?? null;
}

/** The options of one list: [{value, label, ...}], or [] if not loaded yet. */
export function getDropdownOptions(listKey) {
  return Array.isArray(cache[listKey]) ? cache[listKey] : [];
}

/** Has this list been loaded? A parser must not reject a value it cannot check. */
export function hasDropdownOptions(listKey) {
  return Array.isArray(cache[listKey]);
}

/**
 * A form's options plus the value the record already holds, if the list no
 * longer offers it.
 *
 * Archiving an entry takes it off new forms, but a student who already holds it
 * still does. Without this their edit form would show a blank select - and
 * saving it would quietly clear a value nobody chose to remove.
 */
export function optionsWithCurrent(options, currentValue) {
  const list = Array.isArray(options) ? options : [];
  const current = currentValue == null ? "" : String(currentValue);
  if (current === "" || list.some((option) => String(option.value) === current)) return list;
  return [...list, { value: current, label: `${current} (archived)` }];
}

/** Just the stored values of one list, in order. */
export function getDropdownValues(listKey) {
  return getDropdownOptions(listKey).map((option) => option.value);
}

/**
 * Fetch every list. Concurrent callers share the one request in flight; a
 * failure leaves the cache as it was and lets the next caller try again.
 */
export function loadDropdownOptions() {
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(getBackendUrl("dropdown_options.php"));
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.message || "Failed to load the dropdown lists");
    }
    primeDropdownOptions(data?.options || {}, data?.defaults || {});
    return cache;
  })();

  inflight.catch(() => {}).finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * The lists, for a component: `const { genders } = useDropdownOptions()`.
 *
 * Returns the cache object itself, which is replaced (never mutated) when new
 * lists arrive - so it is a sound useMemo dependency for anything derived from
 * the lists, and a component re-renders exactly when they change.
 *
 * Refetches on every mount rather than once per session, so a list changed on
 * the Dropdown Management screen reaches a form the next time it is opened -
 * without a reload, and without the management screen having to know which
 * forms are listening.
 */
export default function useDropdownOptions() {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    loadDropdownOptions().catch(() => {
      // The forms still render; a list that did not load offers nothing, and
      // the server refuses any value that is not on it.
    });
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return cache;
}
