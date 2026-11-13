import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import { getFinanceBands, saveFinanceBands } from "../../../shared/services/api";
import { notifyError, notifySuccess, confirmAction } from "../../../shared/lib/notify";
import { canModuleAction } from "../../../shared/lib/roleAccess";

/**
 * The balance bands, edited as one ladder.
 *
 * A student's balance is filed under one of these bands when the cashier's
 * spreadsheet is imported, and the band is what the Finance module lists, the
 * overview chart groups by, and the priority list prints as part of a segment.
 * Until now the cut-offs were written into two PHP files, so the five bands on
 * Status Management could be renamed and added to with no effect whatsoever.
 *
 * ## Why one Save for the whole table
 *
 * The bands are contiguous: each starts exactly where the one below it ends,
 * which is what guarantees every balance lands in exactly one band. That makes
 * a boundary a single decision shared by two rows. Editing one row at a time
 * would mean either refusing every edit (because the ladder is briefly
 * inconsistent) or saving a gap that sends a range of balances to NULL on the
 * next import without saying so.
 *
 * So this screen edits BOUNDARIES, not rows. Change the number where two bands
 * meet and both move; the column of "starts at" cells is derived and read-only.
 * The server checks the same rule again before writing.
 */

/** Bounds are exclusive at the bottom, inclusive at the top. */
const BOUNDARY_HELP =
  "A balance sits in a band when it is above the band's start and at or below its end. " +
  "Exactly 3,000 belongs to the band ending at 3,000, not the one starting there.";

const money = (value) =>
  value === null || value === undefined || value === ""
    ? ""
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** A row's id for React, stable across edits including for unsaved rows. */
let draftSeq = 0;
const nextDraftKey = () => `draft-${(draftSeq += 1)}`;

function toDraft(band) {
  return {
    key: band.status_id ? `status-${band.status_id}` : nextDraftKey(),
    status_id: band.status_id ?? null,
    status_name: band.status_name ?? "",
    // Held as strings so a half-typed "10" is not read as ten while the
    // administrator is still typing "10000".
    range_max: band.range_max === null || band.range_max === undefined ? "" : String(Number(band.range_max)),
  };
}

export default function FinanceBandsPanel({ permissions = null, onSummaryChange }) {
  const [bands, setBands] = useState([]);
  const [installed, setInstalled] = useState(true);
  const [usingFallback, setUsingFallback] = useState(false);
  const [serverProblems, setServerProblems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  // The endpoint requires admin on the write. Mirroring it keeps the fields from
  // looking editable to somebody the server will refuse.
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getFinanceBands();
      const list = Array.isArray(data?.bands) ? data.bands : [];
      setBands(list.map(toDraft));
      setInstalled(data?.installed !== false);
      setUsingFallback(Boolean(data?.using_fallback));
      setServerProblems(Array.isArray(data?.problems) ? data.problems : []);
      setDirty(false);
    } catch (err) {
      setError(err?.message || "Failed to load balance bands.");
      setBands([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof onSummaryChange !== "function") return;
    if (!installed) {
      onSummaryChange("Not installed — run the balance band migration");
      return;
    }
    if (usingFallback) {
      onSummaryChange("Using the built-in bands — the saved ones have a gap");
      return;
    }
    onSummaryChange(`${bands.length} band${bands.length === 1 ? "" : "s"}`);
  }, [installed, usingFallback, bands.length, onSummaryChange]);

  /**
   * What is wrong with the ladder on screen right now.
   *
   * The same rules the server applies, run on every keystroke so Save can be
   * disabled rather than the administrator finding out after submitting. The
   * server checks again — this is convenience, not the guarantee.
   */
  const problems = useMemo(() => {
    const found = [];
    if (bands.length === 0) {
      return ["There has to be at least one band, or an imported balance has nowhere to go."];
    }
    const seen = new Set();
    bands.forEach((band, index) => {
      const name = band.status_name.trim();
      if (!name) found.push(`Band ${index + 1} needs a name.`);
      const lower = name.toLowerCase();
      if (lower && seen.has(lower)) found.push(`Two bands are both called "${name}".`);
      seen.add(lower);

      const isLast = index === bands.length - 1;
      if (isLast) {
        if (band.range_max.trim() !== "") {
          found.push("The highest band must be left open, so no balance is too large to file.");
        }
        return;
      }
      if (band.range_max.trim() === "") {
        found.push(`"${name || `Band ${index + 1}`}" needs an end amount — only the highest band is left open.`);
        return;
      }
      if (!Number.isFinite(Number(band.range_max))) {
        found.push(`"${name || `Band ${index + 1}`}" has an end amount that is not a number.`);
        return;
      }
      const previous = index === 0 ? null : Number(bands[index - 1].range_max);
      if (index > 0 && Number.isFinite(previous) && Number(band.range_max) <= previous) {
        found.push(`"${name}" must end above ${money(previous)}, where the band below it ends.`);
      }
    });
    return found;
  }, [bands]);

  const setBand = useCallback((index, patch) => {
    setBands((current) => current.map((band, i) => (i === index ? { ...band, ...patch } : band)));
    setDirty(true);
  }, []);

  /** Split a band in two. The new one takes the top half of the old one's range. */
  const splitBand = useCallback((index) => {
    setBands((current) => {
      const next = [...current];
      const band = next[index];
      // The new band inherits the old one's ceiling; the old one needs a new
      // ceiling, which the administrator types. Left blank rather than guessed:
      // a made-up midpoint would look like a decision somebody made.
      next.splice(index + 1, 0, {
        key: nextDraftKey(),
        status_id: null,
        status_name: "",
        range_max: band.range_max,
      });
      next[index] = { ...band, range_max: "" };
      return next;
    });
    setDirty(true);
  }, []);

  /** Retire a band. Its range is absorbed by the one below it. */
  const removeBand = useCallback(async (index) => {
    const band = bands[index];
    const isLast = index === bands.length - 1;
    const absorber = isLast ? bands[index - 1] : bands[index + 1];
    if (!absorber) {
      notifyError("The last remaining band cannot be removed.");
      return;
    }

    const confirmed = await confirmAction({
      title: `Retire "${band.status_name || "this band"}"?`,
      text:
        `Balances in this range will move to "${absorber.status_name || "the next band"}". ` +
        "Records already filed under it keep its name — it just stops taking new ones.",
      confirmButtonText: "Retire band",
    });
    if (!confirmed) return;

    setBands((current) => {
      const next = [...current];
      next.splice(index, 1);
      // The band below inherits the ceiling of the one that went, so the ladder
      // closes over the hole rather than leaving one.
      if (!isLast && index > 0) next[index - 1] = { ...next[index - 1], range_max: band.range_max };
      if (isLast && next.length) next[next.length - 1] = { ...next[next.length - 1], range_max: "" };
      return next;
    });
    setDirty(true);
  }, [bands]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const payload = bands.map((band, index) => ({
        status_id: band.status_id,
        status_name: band.status_name.trim(),
        // The floor is derived, never typed: it is the ceiling of the band
        // below, which is what makes a gap unrepresentable on this screen.
        range_min: index === 0 ? null : Number(bands[index - 1].range_max),
        range_max: index === bands.length - 1 ? null : Number(band.range_max),
      }));
      const data = await saveFinanceBands(payload);
      const list = Array.isArray(data?.bands) ? data.bands : [];
      setBands(list.map(toDraft));
      setUsingFallback(Boolean(data?.using_fallback));
      setServerProblems(Array.isArray(data?.problems) ? data.problems : []);
      setDirty(false);
      notifySuccess(data?.message || "Balance bands saved.");
    } catch (err) {
      notifyError(err?.message || "Failed to save balance bands.");
    } finally {
      setSaving(false);
    }
  }, [bands]);

  const disabled = !canEdit || !installed;

  return (
    <DashboardPanel>
      <SectionHeader title="Balance Bands" />

      <p style={{ margin: "0 0 4px", color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.5 }}>
        The ranges an imported balance is filed under. Change where two bands meet and both move — the
        band below ends there and the band above starts there, so no balance is ever left without one.
      </p>
      <p style={{ margin: "0 0 12px", color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.5 }}>
        {BOUNDARY_HELP}
      </p>

      {error ? <AlertMessage type="error" message={error} /> : null}

      {!installed ? (
        <AlertMessage
          type="warning"
          message="Balance bands are not editable yet. Run migrations/2026_09_09_finance_band_thresholds.sql, then reload this panel. Imports are using the built-in bands until then."
        />
      ) : null}

      {installed && usingFallback ? (
        <AlertMessage
          type="warning"
          message={
            "The saved bands could not be used, so imports are falling back to the built-in ones. " +
            (serverProblems[0] || "Fix the ranges below and save.")
          }
        />
      ) : null}

      {loading ? <p style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Loading…</p> : null}

      <div style={{ display: "grid", gap: 6 }}>
        {bands.map((band, index) => {
          const isLast = index === bands.length - 1;
          const floor = index === 0 ? null : bands[index - 1].range_max;
          return (
            <div
              key={band.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                padding: "6px 8px",
                border: "1px solid var(--border-base)",
                borderRadius: 6,
                background: band.status_id ? "var(--surface-base)" : "var(--surface-page)",
              }}
            >
              <input
                value={band.status_name}
                disabled={disabled}
                maxLength={50}
                placeholder="Band name"
                onChange={(event) => setBand(index, { status_name: event.target.value })}
                style={{
                  flex: "1 1 150px",
                  minWidth: 120,
                  padding: "6px 8px",
                  border: "1px solid var(--border-base)",
                  borderRadius: 5,
                  background: disabled ? "var(--surface-page)" : "var(--surface-base)",
                  color: "var(--text-primary)",
                }}
                name={`finance_band_name_${index}`}
                aria-label={`Name for band ${index + 1}`}
              />

              {/* Derived, never typed — this is the boundary owned by the row above. */}
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", minWidth: 96 }}>
                {index === 0 ? "any balance up to" : `over ${money(floor)} up to`}
              </span>

              {isLast ? (
                <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96, fontWeight: 600 }}>
                  no upper limit
                </span>
              ) : (
                <input
                  value={band.range_max}
                  disabled={disabled}
                  inputMode="decimal"
                  placeholder="0.00"
                  onChange={(event) => setBand(index, { range_max: event.target.value })}
                  style={{
                    width: 96,
                    padding: "6px 8px",
                    border: "1px solid var(--border-base)",
                    borderRadius: 5,
                    background: disabled ? "var(--surface-page)" : "var(--surface-base)",
                    color: "var(--text-primary)",
                    textAlign: "right",
                  }}
                  name={`finance_band_max_${index}`}
                  aria-label={`Upper amount for ${band.status_name || `band ${index + 1}`}`}
                />
              )}

              <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                <Button onClick={() => splitBand(index)} disabled={disabled} variant="secondary" size="sm" title="Split this band in two">
                  Split
                </Button>
                <Button
                  onClick={() => void removeBand(index)}
                  disabled={disabled || bands.length < 2}
                  variant="danger"
                  title="Retire this band"
                >
                  Retire
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {problems.length ? (
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--danger-600, #b42318)", fontSize: 12 }}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center" }}>
        <Button onClick={() => void handleSave()} disabled={disabled || saving || !dirty || problems.length > 0}>
          {saving ? "Saving…" : "Save bands"}
        </Button>
        {dirty ? (
          <Button onClick={() => void load()} disabled={saving} variant="secondary">
            Discard changes
          </Button>
        ) : null}
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
          {dirty ? "Not saved yet — imports still use the saved bands." : "Saved. New imports use these bands."}
        </span>
      </div>
    </DashboardPanel>
  );
}
