import React, { useEffect, useMemo, useRef, useState } from "react";
import Pagination from "../../shared/components/ui/Pagination";
import { SkeletonText } from "../../shared/components/ui/Skeleton";
import usePagedRows from "../../shared/hooks/usePagedRows";
import { surveyTextLimit } from "./textLimits";

/*
 * Folders to a page, and the sizes offered beside the pager.
 *
 * Multiples of 12 rather than the control's default 10/20/50/100 because the
 * grid lays out 2, 3 or 4 columns depending on the width it is given, and 12
 * fills whole rows in all three — a trailing row holding one card is the thing
 * you notice about a grid that ends on 10.
 *
 * The default must also be one of the options: the Rows control is a controlled
 * <select>, so a size with no matching <option> renders blank.
 */
const FOLDERS_PER_PAGE = 12;
const FOLDER_PAGE_SIZES = [12, 24, 48, 96];

/**
 * The shelf: surveys as folders, shown before anything inside one of them.
 *
 * Two screens open onto a survey's contents — Submissions asks "who answered
 * this?" and Questions asks "what does this ask?" — and both were previously a
 * flat, paged table of every survey's rows interleaved, with an accordion band
 * trying to separate them. Choosing the survey first is the honest shape: it is
 * the question the reader already has before they arrive.
 *
 * Shared rather than written twice because the two shelves must agree about
 * what a folder looks like. A folder that means one thing on one screen and
 * something slightly different on the next is worse than either.
 *
 * What differs between them is only the number on the card, so that is the one
 * thing the caller supplies: `primary` names the count that matters here, and
 * `caption` says whatever the other screen would have said instead.
 */
/**
 * Whether a survey has been retired.
 *
 * Matched against the word "Inactive" and nothing else, on purpose. A survey
 * whose status row is missing entirely is not the same thing as one somebody
 * closed, and reading "no status" as retired would grey out folders nobody has
 * touched. Unknown counts as active, which is the harmless direction: the worst
 * case is a live-looking folder that is already finished, not a finished-looking
 * folder people stop opening.
 */
export function surveyIsInactive(folder) {
  return String(folder?.status_name || "").trim().toLowerCase() === "inactive";
}

/** All / Active / Inactive, each carrying how many it would show. */
function StatusTabs({ value, counts, onChange }) {
  const tabs = [
    { key: "all", label: "All", count: counts.all },
    { key: "active", label: "Active", count: counts.active },
    { key: "inactive", label: "Inactive", count: counts.inactive },
  ];

  return (
    <div role="group" aria-label="Filter surveys by status" style={{ display: "inline-flex", border: "1px solid var(--border-base)", borderRadius: 6, overflow: "hidden" }}>
      {tabs.map((tab) => {
        const selected = value === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange?.(tab.key)}
            style={{
              font: "inherit",
              fontSize: 11.5,
              padding: "5px 10px",
              border: 0,
              borderLeft: tab.key === "all" ? 0 : "1px solid var(--border-base)",
              cursor: "pointer",
              background: selected ? "var(--brand-600)" : "transparent",
              color: selected ? "#fff" : "var(--text-secondary)",
              fontWeight: selected ? 700 : 500,
            }}
          >
            {tab.label}
            <span style={{ marginLeft: 5, fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function SurveyFolderShelf({
  heading = "Choose a survey",
  hint = "",
  folders = [],
  loading = false,
  search = "",
  onSearchChange,
  onOpen,
  primary,
  caption,
  status = "all",
  onStatusChange,
  emptyText = "No surveys have been created yet.",
}) {
  const filtered = useMemo(() => {
    const needle = String(search || "").trim().toLowerCase();
    return folders.filter((folder) => {
      if (needle && !String(folder.survey_title || "").toLowerCase().includes(needle)) {
        return false;
      }
      if (status === "all") return true;
      return surveyIsInactive(folder) === (status === "inactive");
    });
  }, [folders, search, status]);

  // Counts come from `folders`, not `filtered` - a tab that reported the number
  // left after its own filter had been applied would always read the same as
  // the grid below it and tell the reader nothing.
  const counts = useMemo(() => {
    const inactive = folders.filter(surveyIsInactive).length;
    return { all: folders.length, active: folders.length - inactive, inactive };
  }, [folders]);

  /*
   * Both shelves fetch every survey in one `group_by=survey` request and filter
   * in the browser, so what needs paging is the grid, not a second query —
   * hence usePagedRows over the array already in hand.
   *
   * Paged over `filtered` rather than `folders`, so the pager counts what the
   * search box and the status tab actually left on screen. That also means the
   * list can shrink under you: usePagedRows clamps the page on read, so
   * narrowing a nine-page shelf to two never renders an empty page first.
   */
  const paged = usePagedRows(filtered, FOLDERS_PER_PAGE);

  return (
    <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 9, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ color: "var(--text-primary)" }}>{heading}</strong>
          {hint ? (
            <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 2 }}>{hint}</div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {onStatusChange ? (
            <StatusTabs value={status} counts={counts} onChange={onStatusChange} />
          ) : null}
          <input
            value={search}
            onChange={(e) => onSearchChange?.(e.target.value)}
            placeholder="Find a survey..."
            aria-label="Find a survey"
            style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, width: 186 }}
            name="survey_folder_search"
          />
        </div>
      </div>

      {loading ? (
        <SkeletonText lines={4} />
      ) : filtered.length === 0 ? (
        <div style={{ padding: 26, textAlign: "center", color: "var(--text-muted)" }}>
          {/* Three different nothings, and saying which one it is saves the
              reader from hunting for a survey the status tab is hiding. */}
          {folders.length === 0
            ? emptyText
            : status !== "all" && counts[status] === 0
              ? `No ${status} survey. ${counts.all} survey${counts.all === 1 ? "" : "s"} in all.`
              : "No survey matches that name."}
        </div>
      ) : (
        <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(232px, 100%), 1fr))", gap: 12 }}>
          {paged.rows.map((folder) => {
            const title = folder.survey_title || `Survey #${folder.survey_id}`;
            const count = primary ? Number(primary(folder).value || 0) : 0;
            const noun = primary ? primary(folder).noun : "";
            const inactive = surveyIsInactive(folder);
            // The semester and date are what tell two same-named folders
            // apart: a title may repeat in another semester or year.
            const metaParts = [
              folder.semester_name || null,
              [1, 2, 3].includes(Number(folder.period)) ? `Period ${Number(folder.period)}` : null,
              folder.date,
            ].filter(Boolean);
            return (
              <button
                key={folder.survey_id}
                type="button"
                className="survey-card"
                /* An empty folder still opens - it just stops competing for
                   attention with the ones that have something in them. */
                data-empty={count === 0 ? "true" : undefined}
                /* Set after data-empty so a retired folder that also happens to
                   be empty reads as retired: "nobody answered it" is the less
                   useful of the two facts once the survey is closed. */
                data-inactive={inactive ? "true" : undefined}
                onClick={() => onOpen?.(folder)}
                aria-label={`Open ${title}${inactive ? " (inactive)" : ""}: ${count} ${noun}${count === 1 ? "" : "s"}`}
              >
                <span style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <span className="survey-card-icon">
                    <IconFolder filled={count > 0} />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 600, color: "var(--text-primary)", overflowWrap: "anywhere" }}>
                      {title}
                    </span>
                    {/*
                      * The period sits on the same line as the status rather
                      * than in a badge of its own: a folder card is scanned in
                      * a grid, and a second badge competes with the count that
                      * is the reason to look at the card at all.
                      */}
                    {folder.status_name || metaParts.length ? (
                      <span style={{ display: "block", color: "var(--text-muted)", fontSize: 10.5, marginTop: 2 }}>
                        {/* Inactive gets the badge; Active stays plain text.
                            Highlighting both would make the two states cost the
                            same to read, and only one of them is news. */}
                        {folder.status_name ? (
                          inactive
                            ? <span className="survey-card-flag">{folder.status_name}</span>
                            : folder.status_name
                        ) : null}
                        {folder.status_name && metaParts.length ? " · " : null}
                        {metaParts.join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </span>

                <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                  <span style={{ fontSize: 19.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: count > 0 ? "var(--brand-800)" : "var(--text-muted)" }}>
                    {count}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                    {noun}
                    {count === 1 ? "" : "s"}
                  </span>
                </span>

                {caption ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{caption(folder)}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/*
          * Wired handler by handler rather than {...paged}: usePagedRows names
          * its setters setPage / setPageSize, so spreading it leaves
          * onPageChange undefined — a pager that counts the pages correctly,
          * highlights the right one, and silently refuses to move. Faculty
          * Workspace shipped exactly that.
          */}
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
          pageSizeOptions={FOLDER_PAGE_SIZES}
          itemLabel="surveys"
          compact
        />
        </>
      )}
    </div>
  );
}

/** The mark on a survey's folder. A full one gets a page peeking out of it. */
export function IconFolder({ filled }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      {filled ? <path d="M7 12h10M7 15h6" /> : null}
    </svg>
  );
}

/** Back out of a folder to the shelf of surveys. */
export function IconBack() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/**
 * The bar above a folder's contents: how to get out, and what you are inside.
 *
 * Shared for the same reason the shelf is — leaving a folder should be the same
 * gesture in the same place on both screens.
 *
 * `onRename` is optional and the title stays plain text without it. Where it is
 * supplied the title becomes editable in place: the survey you are inside is
 * named right here, and leaving for another screen to fix a typo in that name,
 * then finding your way back into the folder, is a long walk for one word. It
 * takes the new title and returns a promise; the caller owns the save.
 */
export function SurveyFolderHeader({ survey, subtitle, onBack, onRename = null, children }) {
  const title = survey?.survey_title || `Survey #${survey?.survey_id}`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  /*
   * A different folder is a different title. Without this, opening another
   * survey while a rename was half-typed would offer that text as the new
   * survey's name.
   */
  useEffect(() => {
    setEditing(false);
    setDraft(title);
  }, [survey?.survey_id, title]);

  useEffect(() => {
    // Selected, not merely focused: a rename is usually a retype, and the
    // common case should not begin with the author clearing the field by hand.
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    // Unchanged or emptied is a cancel, not a save. The server rejects an empty
    // title anyway; this just declines to ask it.
    if (!next || next === title) {
      setEditing(false);
      setDraft(title);
      return;
    }

    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch (_) {
      // The caller puts the message in the page's error box. The field stays
      // open holding what was typed, so it can be corrected and retried.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 9px 0" }}>
      <button
        type="button"
        onClick={onBack}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: "1px solid var(--border-base)", color: "var(--text-secondary)", padding: "4px 8px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 11.5, flexShrink: 0 }}
      >
        <IconBack />
        All surveys
      </button>
      <div style={{ minWidth: 0, flex: 1 }}>
        {editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(title);
                  setEditing(false);
                }
              }}
              maxLength={surveyTextLimit("survey_title")}
              aria-label="Survey title"
              name="survey_folder_title"
              style={{ flex: 1, minWidth: 0, font: "inherit", fontWeight: 700, color: "var(--text-primary)", padding: "3px 6px", border: "1px solid var(--brand-500, var(--border-base))", borderRadius: 5, background: "var(--surface-base)" }}
            />
            <button
              type="button"
              onClick={() => void commit()}
              disabled={saving}
              style={{ background: "var(--brand-700)", color: "#fff", border: 0, padding: "4px 9px", borderRadius: 5, cursor: saving ? "default" : "pointer", font: "inherit", fontSize: 11.5, flexShrink: 0 }}
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(title);
                setEditing(false);
              }}
              disabled={saving}
              style={{ background: "transparent", border: "1px solid var(--border-base)", color: "var(--text-secondary)", padding: "4px 8px", borderRadius: 5, cursor: "pointer", font: "inherit", fontSize: 11.5, flexShrink: 0 }}
            >
              Cancel
            </button>
          </div>
        ) : onRename ? (
          /* The title itself is the control. A pencil parked elsewhere in the
             bar would be one more thing to find; this is the word that is
             wrong, so this is the thing to click. */
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Rename this survey"
            className="survey-folder-title"
          >
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
            <IconPencil />
          </button>
        ) : (
          <strong style={{ display: "block", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </strong>
        )}
        <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

/** Sits beside an editable survey title. */
function IconPencil() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
