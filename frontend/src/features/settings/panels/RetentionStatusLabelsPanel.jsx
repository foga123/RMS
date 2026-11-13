import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import { getRetentionStatusLabels, renameRetentionStatusLabel } from "../../../shared/services/api";
import { notifyError, notifySuccess } from "../../../shared/lib/notify";
import { canModuleAction } from "../../../shared/lib/roleAccess";

/**
 * Renaming the retention statuses, without renaming what they are.
 *
 * A retention case moves through a fixed set of states, and the server decides
 * what a case counts as by comparing those states literally — a case is
 * resolved because `intervention_status === "resolved"`. That comparison is why
 * the states themselves are not editable here and why this panel only ever
 * writes one column.
 *
 * What a college calls them is a different question. "Approved" may need to
 * read "Endorsed", "Resolved" may need to read "Closed", and neither is worth a
 * redeploy. So the code stays and the word moves, which is the same split
 * risk_category has always had between category_code and category_name.
 *
 * The panel says this out loud rather than leaving it implicit: each row shows
 * the code underneath the name, because an admin renaming "Resolved" to
 * "Closed" should be able to see that reports and exports still say `resolved`
 * underneath.
 */

/** What each group is for, in the one line a reader needs before editing it. */
const GROUP_BLURBS = {
  validation: "Where a case sits with the dean — whether the evaluation has been accepted.",
  intervention: "How far the call or visit has got, from nobody assigned through to finished.",
  risk_level: "The bands the risk score falls into. Renaming these does not change the thresholds.",
};

export default function RetentionStatusLabelsPanel({ permissions = null, onSummaryChange }) {
  const [groups, setGroups] = useState([]);
  const [installed, setInstalled] = useState(true);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  // The endpoint requires admin on the write. Mirroring it here keeps the field
  // from looking editable to someone the server will refuse.
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getRetentionStatusLabels();
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
      setInstalled(data?.installed !== false);
      // Drafts are rebuilt from the server's answer on every load, so a failed
      // save leaves the box showing what is actually stored rather than the
      // text that did not take.
      const next = {};
      (Array.isArray(data?.groups) ? data.groups : []).forEach((group) => {
        (group.items || []).forEach((item) => {
          if (item.label_id != null) next[item.label_id] = item.label;
        });
      });
      setDrafts(next);
    } catch (err) {
      setError(err?.message || "Failed to load retention status labels.");
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const renamedCount = useMemo(() => {
    // "Renamed" means differs from the code prettified — the word the board
    // printed before any of this was editable.
    let count = 0;
    groups.forEach((group) => {
      (group.items || []).forEach((item) => {
        const builtIn = String(item.status_code || "")
          .replace(/_/g, " ")
          .replace(/\b\w/g, (character) => character.toUpperCase());
        if (String(item.label || "").trim() && item.label !== builtIn) count += 1;
      });
    });
    return count;
  }, [groups]);

  useEffect(() => {
    if (typeof onSummaryChange !== "function") return;
    if (!installed) {
      onSummaryChange("Not installed — run the retention status label migration");
      return;
    }
    onSummaryChange(
      renamedCount === 0
        ? "Using the default status names"
        : `${renamedCount} status ${renamedCount === 1 ? "name" : "names"} renamed`,
    );
  }, [installed, renamedCount, onSummaryChange]);

  const handleSave = useCallback(async (item) => {
    const next = String(drafts[item.label_id] ?? "").trim();
    if (!next) {
      notifyError("A status needs a name.");
      return;
    }
    if (next === item.label) return;

    setSavingId(item.label_id);
    try {
      const data = await renameRetentionStatusLabel(item.label_id, next);
      if (Array.isArray(data?.groups)) setGroups(data.groups);
      notifySuccess(data?.message || "Status renamed.");
    } catch (err) {
      notifyError(err?.message || "Failed to rename status.");
      // Put the stored value back, so the box never keeps a name that was not saved.
      setDrafts((current) => ({ ...current, [item.label_id]: item.label }));
    } finally {
      setSavingId(null);
    }
  }, [drafts]);

  return (
    <DashboardPanel>
      <SectionHeader title="Retention Status Names" />

      <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.5 }}>
        Change the words the retention board prints for each status. The status itself does not
        change — reports, exports and the case history keep using the code shown under each name,
        so counts and filters carry on working after a rename.
      </p>

      {error ? <AlertMessage type="error" message={error} /> : null}

      {!installed ? (
        <AlertMessage
          type="warning"
          message="Status names are not editable yet. Run migrations/2026_09_09_retention_status_label.sql, then reload this panel. The board is showing its built-in names until then."
        />
      ) : null}

      {loading ? (
        <p style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Loading…</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.status_group} style={{ marginBottom: 18 }}>
          <h4 style={{ margin: "0 0 2px", fontSize: 13, color: "var(--text-primary)" }}>{group.title}</h4>
          <p style={{ margin: "0 0 8px", fontSize: 11.5, color: "var(--text-muted)" }}>
            {GROUP_BLURBS[group.status_group] || ""}
          </p>

          <div style={{ display: "grid", gap: 7 }}>
            {(group.items || []).map((item) => {
              const disabled = !canEdit || !installed || item.label_id == null;
              const draft = drafts[item.label_id] ?? item.label;
              const dirty = item.label_id != null && draft.trim() !== item.label;
              return (
                <div
                  key={`${group.status_group}:${item.status_code}`}
                  style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                >
                  <div style={{ display: "grid", gap: 2, minWidth: 210, flex: "1 1 210px" }}>
                    <input
                      value={draft}
                      disabled={disabled}
                      maxLength={60}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [item.label_id]: event.target.value }))
                      }
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        border: "1px solid var(--border-base)",
                        borderRadius: 5,
                        background: disabled ? "var(--surface-page)" : "var(--surface-base)",
                        color: "var(--text-primary)",
                      }}
                      name={`retention_status_label_${group.status_group}_${item.status_code}`}
                      aria-label={`Name for ${item.status_code}`}
                    />
                    <code style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{item.status_code}</code>
                  </div>

                  <Button
                    onClick={() => handleSave(item)}
                    disabled={disabled || !dirty || savingId === item.label_id}
                  >
                    {savingId === item.label_id ? "Saving…" : "Save"}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </DashboardPanel>
  );
}
