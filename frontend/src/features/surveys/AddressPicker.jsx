import React, { useEffect, useId, useRef, useState } from "react";
import { getBackendUrl } from "../../shared/lib/url";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import SearchableSelect from "../../shared/components/ui/SearchableSelect";

/**
 * A Philippine address: the street typed, the place chosen, the ZIP filled in.
 *
 * Laid out the way the College writes an address on a form -
 *
 *   House no. / street     123 Rizal Street, Maria Clara Subdivision   typed
 *   Province               Misamis Oriental                            dropdown
 *   City / Municipality    Cagayan de Oro City                         dropdown
 *   Barangay               Camaman-an                                  dropdown
 *   ZIP code               9000                                        filled in
 *
 * - and stored as the one line those make:
 *
 *   123 Rizal Street, Maria Clara Subdivision, Brgy. Camaman-an,
 *   Cagayan de Oro City, Misamis Oriental 9000
 *
 * One line because that is what survey_answer holds and what every export,
 * panel and report downstream already displays. The structure is a better way
 * to COLLECT an address, not a reason to change how one is stored.
 *
 * PROVINCE FIRST. The list used to open on the seventeen regions, and that step
 * hid this college's own city: PSGC files Cagayan de Oro beside Misamis
 * Oriental rather than inside it, so a student who opened the province did not
 * find it. The server now starts at the province and puts each such city in the
 * province it sits in (lib/ph_address.php). Below the province the steps still
 * follow the data - Manila has a District step, nowhere else does - so the
 * chain asks what is inside whatever was chosen last and stops at the bottom.
 *
 * THE ZIP IS FILLED IN, AND STAYS EDITABLE. PSGC has no ZIP codes, so they come
 * from PHLPost's list, matched to each town (tools/import_zip_codes.php), and
 * arrive with each choice as `zip_codes`. Choosing Cagayan de Oro City fills in
 * 9000. A town with postal areas of its own switches when the barangay names
 * one (Davao City 8000, its barangay Toril 8025). A Metro Manila city has no
 * ZIP for the whole city, so its areas are offered as choices instead, until
 * the district or barangay picks one. A ZIP the student typed is never
 * replaced. It is optional, and four digits when given.
 *
 * Degrades on purpose: with no address data loaded it is a plain text box. The
 * PSGC list is reference data the college loads once (tools/import_psgc.php),
 * and a survey that refused to accept an address until somebody had done that
 * would be a worse survey than one that lets a student type it.
 */

/** The separator between an address's parts. */
export const ADDRESS_SEPARATOR = ", ";

/** A Philippine ZIP code is four digits. */
export const ZIP_PATTERN = /^\d{4}$/;

/** Long enough for a house, a street and a subdivision; short enough to fit the line. */
const STREET_MAX_LENGTH = 120;

/** Manila's barangays are named "Barangay 287"; those do not need a "Brgy." too. */
const NAMED_AS_BARANGAY = /^(barangay|brgy)\b/i;

/**
 * Build the stored line from the street, the chosen path and the ZIP.
 *
 * This is the only place an address is composed - the server stores what it is
 * sent - so the preview under the picker is exactly what is filed.
 *
 * The path arrives outermost-first, the order it was picked in, and is written
 * innermost-first, the order an address is read in. The barangay is marked
 * "Brgy." so it cannot be read as a street or a subdivision, and the ZIP follows
 * the province after a space, the way it is written on an envelope.
 *
 * A region never belongs in the line - nobody writes "Region X" on an envelope -
 * so one is skipped if it ever reaches here.
 */
export function composeAddress(street, path, zip = "") {
  const parts = [];
  const trimmedStreet = String(street ?? "").trim();
  if (trimmedStreet) parts.push(trimmedStreet);

  [...(path || [])]
    .reverse()
    .filter((step) => step && step.level !== "region" && String(step.name ?? "").trim())
    .forEach((step) => {
      const name = String(step.name).trim();
      parts.push(step.level === "barangay" && !NAMED_AS_BARANGAY.test(name) ? `Brgy. ${name}` : name);
    });

  const line = parts.join(ADDRESS_SEPARATOR);
  const trimmedZip = String(zip ?? "").trim();
  return line && trimmedZip ? `${line} ${trimmedZip}` : line;
}

/**
 * The steps still ahead of the chain, shown greyed out.
 *
 * Without these the form grew a field at a time as each dropdown was answered,
 * and the ZIP box jumped down the page twice. Showing the whole shape from the
 * start - disabled until its turn - is how every address form reads. Manila's
 * District step is not predicted; it appears when Manila is chosen.
 */
const EXPECTED_STEPS = ["Province", "City / Municipality", "Barangay"];

export function upcomingSteps(chain, bottomed) {
  if (bottomed) return [];
  const last = chain[chain.length - 1];
  if (!last) return [];
  if (last.label === "District") return ["Barangay"];
  const at = EXPECTED_STEPS.indexOf(last.label);
  return at === -1 ? [] : EXPECTED_STEPS.slice(at + 1);
}

const fieldStyle = { display: "grid", gap: 4, minWidth: 0 };
const labelStyle = { fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 600 };
const optionalStyle = { fontWeight: 400, color: "var(--text-muted)" };

function inputStyle(invalid) {
  return {
    width: "100%",
    padding: "10px 11px",
    fontSize: 14,
    borderRadius: 10,
    border: `1px solid ${invalid ? "var(--danger-500)" : "var(--border-strong)"}`,
    background: "var(--surface-base)",
    color: "var(--text-primary)",
    boxSizing: "border-box",
  };
}

async function fetchLevel(parentCode) {
  const query = parentCode ? `?parent=${encodeURIComponent(parentCode)}` : "";
  const res = await fetch(getBackendUrl(`ph_address.php${query}`), { credentials: "include" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message || "Could not load the address list");
  return body?.data || {};
}

/**
 * The ZIP the chosen places point to, and the choices to offer.
 *
 * Each step keeps the `zip_codes` that came back when it was chosen. Walked
 * outermost first, so the deepest step that names one ZIP wins: Davao City
 * gives 8000, its barangay Toril then gives 8025, and a barangay that names no
 * postal area leaves the city's 8000 standing. A step with several ZIPs names
 * one only if exactly one is for the whole place; otherwise it offers them all
 * as `choices` and fills in nothing.
 */
export function zipSuggestion(chain) {
  let zip = "";
  let place = "";
  let choices = [];
  let choicesPlace = "";
  (chain || []).forEach((level) => {
    const list = (level?.zipCodes || []).filter((entry) => ZIP_PATTERN.test(String(entry?.zip ?? "")));
    if (!list.length) return;
    const name = level.options?.find((option) => option.code === level.selected)?.name || "";
    if (list.length > 1) {
      choices = list;
      choicesPlace = name;
    }
    const whole = list.filter((entry) => !entry.area);
    const one = list.length === 1 ? list[0] : whole.length === 1 ? whole[0] : null;
    if (one) {
      zip = one.zip;
      place = name;
    }
  });
  return { zip, place, choices, choicesPlace };
}

/** The chosen entries, outermost first. */
function chosenPath(chain) {
  return chain
    .map((level) => level.options.find((option) => option.code === level.selected))
    .filter(Boolean);
}

export default function AddressPicker({ value = "", onChange, maxLength = 250, invalid = false }) {
  /**
   * One entry per dropdown on screen: what it is called, what it offers, and
   * what is chosen in it. The chain IS the state - which steps exist depends on
   * where you are.
   */
  const [levels, setLevels] = useState([]);
  const [street, setStreet] = useState("");
  const [zip, setZip] = useState("");
  /** The ZIP this picker last filled in, so it can tell it apart from one the student typed. */
  const autoZip = useRef("");
  const zipRef = useRef("");
  zipRef.current = zip;
  const zipListId = useId();
  const [ready, setReady] = useState(null); // null = still asking
  const [error, setError] = useState("");
  const [loadingAt, setLoadingAt] = useState(-1);
  /** The last choice has nothing below it: the address reaches a barangay. */
  const [bottomed, setBottomed] = useState(false);

  /*
   * A saved answer is a composed line, and a line cannot be turned back into the
   * codes that made it - two barangays in different provinces share a name. So a
   * returning student is shown what they answered and offered a fresh start
   * rather than a half-restored cascade that might be wrong.
   */
  const [editing, setEditing] = useState(!value);

  const notify = useRef(onChange);
  notify.current = onChange;
  /** Nothing is sent up until the student has touched the picker. */
  const touched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchLevel(null);
        if (cancelled) return;
        const loaded = Number(data.entries_loaded || 0) > 0 && (data.options || []).length > 0;
        setReady(loaded);
        if (loaded) {
          setLevels([{ label: data.label || "Province", options: data.options || [], selected: "" }]);
        }
      } catch (e) {
        if (!cancelled) {
          // Not fatal. The text box below still collects an address.
          setReady(false);
          setError(e.message || "Could not load the address list");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /*
   * The answer, worked out from the state rather than sent from each handler.
   *
   * A choice is confirmed as the bottom only once the server says nothing is
   * below it, and the student may be typing the street while that answer is
   * on its way; composing here, after the state has settled, means the line
   * always carries the street and ZIP as they are now, not as they were when
   * the dropdown was clicked.
   *
   * Anything short of a barangay - a province, a city with its barangays still
   * unpicked - is sent as empty, which leaves a required question unanswered
   * instead of accepting half an address. So is a ZIP that is not four digits.
   */
  useEffect(() => {
    if (!touched.current || !editing || ready !== true) return;
    const trimmedZip = zip.trim();
    const zipOk = trimmedZip === "" || ZIP_PATTERN.test(trimmedZip);
    const path = chosenPath(levels);
    const reachedBarangay = path.some((place) => place.level === "barangay");
    notify.current?.(bottomed && reachedBarangay && zipOk ? composeAddress(street, path, trimmedZip) : "");
  }, [bottomed, levels, street, zip, editing, ready]);

  /*
   * Fill the ZIP box from the places chosen - unless the student has typed one.
   *
   * The box is only written while it is empty or still holds what this picker
   * put there, so changing the city replaces a ZIP it filled in and never one
   * typed by hand. A place with no single ZIP clears one it filled in, rather
   * than leaving the last city's ZIP under the new city.
   */
  const suggestion = zipSuggestion(levels);
  useEffect(() => {
    const current = zipRef.current;
    if (current !== "" && current !== autoZip.current) return;
    autoZip.current = suggestion.zip;
    setZip(suggestion.zip);
  }, [suggestion.zip]);

  const beginSelection = useLatestRequest();
  async function handleSelect(index, code) {
    const isCurrent = beginSelection();
    setLoadingAt(-1);
    touched.current = true;
    // Everything below the step that changed is now wrong, so it goes - and so
    // do the ZIP codes of the choice being replaced.
    const chain = levels.slice(0, index + 1).map((level, i) => (
      i === index ? { ...level, selected: code, zipCodes: [] } : level
    ));
    setLevels(chain);
    setBottomed(false);

    if (!code) return;

    setLoadingAt(index);
    setError("");
    try {
      const data = await fetchLevel(code);
      if (!isCurrent()) return;
      // The ZIP codes of what was just chosen stay with that step.
      const zipCodes = Array.isArray(data.zip_codes) ? data.zip_codes : [];
      const chosen = chain.map((level, i) => (i === index ? { ...level, zipCodes } : level));
      // is_leaf means the list ends here - a barangay, or a place whose
      // children have not been loaded. Either way there is nothing more to ask.
      if (!data.is_leaf && (data.options || []).length) {
        setLevels([...chosen, { label: data.label || "Location", options: data.options, selected: "" }]);
      } else {
        setLevels(chosen);
        setBottomed(true);
      }
    } catch (e) {
      if (isCurrent()) setError(e.message || "Could not load the next list");
    } finally {
      if (isCurrent()) setLoadingAt(-1);
    }
  }

  function handleStreet(next) {
    touched.current = true;
    setStreet(next);
  }

  function handleZip(next) {
    touched.current = true;
    // Digits only, and never more than four: there is nothing else a ZIP can hold.
    setZip(String(next).replace(/\D/g, "").slice(0, 4));
  }

  // ------------------------------------------------------------ saved answer
  if (!editing) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ padding: "11px 12px", borderRadius: 10, border: "1px solid var(--border-base)", background: "var(--surface-page)", fontSize: 14 }}>
          {value}
        </div>
        <button
          type="button"
          onClick={() => { setEditing(true); setStreet(""); setZip(""); autoZip.current = ""; notify.current?.(""); }}
          style={{ justifySelf: "start", font: "inherit", fontSize: 11.5, background: "transparent", border: "1px solid var(--border-base)", color: "var(--text-secondary)", padding: "4px 9px", borderRadius: 6, cursor: "pointer" }}
        >
          Change address
        </button>
      </div>
    );
  }

  // ------------------------------------------------- no list loaded: type it
  if (ready === false) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <textarea
          value={value || ""}
          maxLength={maxLength}
          onChange={(e) => notify.current?.(e.target.value)}
          placeholder="House no. and street, Barangay, City or Municipality, Province, ZIP code"
          style={{ ...inputStyle(invalid), minHeight: 76, padding: "11px 12px", resize: "vertical" }}
          name="survey_address_freetext"
        />
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {error || "Type your address. The dropdown list has not been set up on this system yet."}
        </span>
      </div>
    );
  }

  if (ready === null) {
    return <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "10px 0" }}>Loading the address list...</div>;
  }

  // ------------------------------------------------------------- the form
  const upcoming = upcomingSteps(levels, bottomed);
  const zipInvalid = zip !== "" && !ZIP_PATTERN.test(zip);
  const zipFilledIn = zip !== "" && zip === autoZip.current;
  const zipChoices = suggestion.choices;
  // Says where a filled-in ZIP came from, or that the student must pick one.
  const zipHint = zipFilledIn && suggestion.place
    ? `ZIP code for ${suggestion.place}. Change it if yours is different.`
    : zip === "" && zipChoices.length
      ? `${suggestion.choicesPlace || "This place"} has more than one ZIP code. Pick yours from the list.`
      : "";
  const unfinished = !bottomed && loadingAt === -1 && levels.some((level) => level.selected);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label style={fieldStyle}>
        <span style={labelStyle}>
          House no., street, subdivision or purok <span style={optionalStyle}>(optional)</span>
        </span>
        <input
          type="text"
          value={street}
          maxLength={STREET_MAX_LENGTH}
          onChange={(e) => handleStreet(e.target.value)}
          placeholder="e.g. 123 Rizal Street, Maria Clara Subdivision"
          autoComplete="street-address"
          style={inputStyle(invalid)}
          name="survey_address_street"
        />
      </label>

      {/* Two to a row where there is room, one on a phone. Every step is a
          dropdown you can type into: eighty barangays in Cagayan de Oro and
          eighty-four provinces are lists nobody should have to scroll. */}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
        {levels.map((level, index) => (
          <div key={`${level.label}-${index}`} style={fieldStyle}>
            <span style={labelStyle}>{level.label}</span>
            <SearchableSelect
              value={level.selected}
              options={level.options}
              onChange={(code) => { void handleSelect(index, code); }}
              disabled={loadingAt === index}
              invalid={invalid && !level.selected}
              label={level.label}
              placeholder={loadingAt === index ? "Loading..." : `Select ${level.label.toLowerCase()}`}
              searchPlaceholder={`Type to find a ${level.label.toLowerCase()}...`}
              emptyText={`No ${level.label.toLowerCase()} matches that.`}
              name={`survey_address_level_${index}`}
            />
          </div>
        ))}

        {upcoming.map((label, i) => {
          const before = i === 0 ? levels[levels.length - 1]?.label : upcoming[i - 1];
          return (
            <div key={`upcoming-${label}`} style={fieldStyle}>
              <span style={{ ...labelStyle, color: "var(--text-muted)" }}>{label}</span>
              <SearchableSelect
                value=""
                options={[]}
                disabled
                label={label}
                placeholder={i === 0 && loadingAt !== -1 ? "Loading..." : `Choose a ${String(before || "").toLowerCase()} first`}
                name={`survey_address_upcoming_${i}`}
              />
            </div>
          );
        })}

        {/* The hint sits outside the label, so the box is still named "ZIP
            code" to a screen reader, and is tied to it by aria-describedby. */}
        <div style={fieldStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>
              ZIP code <span style={optionalStyle}>(optional)</span>
            </span>
            <input
              aria-describedby={zipHint ? `${zipListId}-hint` : undefined}
              type="text"
              inputMode="numeric"
              autoComplete="postal-code"
              value={zip}
              maxLength={4}
              onChange={(e) => handleZip(e.target.value)}
              placeholder="e.g. 9000"
              style={inputStyle(invalid && zipInvalid)}
              name="survey_address_zip"
              list={zipChoices.length ? zipListId : undefined}
            />
          </label>
          {/* A city with several ZIPs: its postal areas, offered as the box is typed in. */}
          {zipChoices.length ? (
            <datalist id={zipListId}>
              {zipChoices.map((entry) => (
                <option key={`${entry.zip}-${entry.area}`} value={entry.zip}>
                  {entry.area || suggestion.choicesPlace}
                </option>
              ))}
            </datalist>
          ) : null}
          {zipHint ? (
            <span id={`${zipListId}-hint`} style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {zipHint}
            </span>
          ) : null}
        </div>
      </div>

      {/* Started but not bottomed out: nudge rather than silently refuse. This is
          why a required question stays blocked - the address is not complete. */}
      {unfinished ? (
        <div style={{ fontSize: 11.5, color: "var(--warning-800)" }}>
          Keep going until you reach your barangay - a city or municipality on its own is not a complete address.
        </div>
      ) : null}

      {zipInvalid ? (
        <div style={{ fontSize: 11.5, color: "var(--warning-800)" }}>
          A ZIP code has 4 digits, like 9000. Leave it blank if you do not know it.
        </div>
      ) : null}

      {/* What will actually be stored. The picker collects parts; the answer is
          one line, and showing it removes any doubt about what was recorded. */}
      {value ? (
        <div style={{ display: "grid", gap: 2, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--border-base)", background: "var(--surface-page)" }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Your address</span>
          <span style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.45 }}>{value}</span>
        </div>
      ) : null}

      {error ? <div style={{ fontSize: 11.5, color: "var(--danger-700)" }}>{error}</div> : null}
    </div>
  );
}
