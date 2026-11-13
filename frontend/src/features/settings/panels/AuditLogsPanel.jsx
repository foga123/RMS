import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime as formatWhen } from "../../../shared/lib/dateTime";
import { Button, ExportMenu, Pagination, SectionHeader, StatCard, StatCardGrid, Tabs } from "../../../shared/components/ui";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../../shared/lib/tableExport";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import Table from "../../../shared/components/Table";
import { getBackendUrl } from "../../../shared/lib/url";
import useLiveRefresh from "../../../shared/hooks/useLiveRefresh";
import { localDateIsoDaysAgo } from "../../../shared/lib/localDate";
import { AUDIT_CATEGORIES, actionCategory, describeAction, metadataFields } from "../../../shared/lib/auditActions";
import { tone } from "../../../shared/theme/tokens";

/**
 * The audit log, as three trails behind one set of tabs.
 *
 *   Sign-ins  logins, logouts, failures and blocks, with the caller's IP and
 *             device. Answers "who was here".
 *   Actions   everything else the server recorded — an account created, a role's
 *             permissions changed, a sheet imported, the database restored.
 *             Answers "who changed what".
 *   This browser  the old localStorage trail, kept and kept labelled.
 *
 * The first two are one server table split by action, so they share a query, a
 * filter bar, a table and a pager: only the columns and the wording differ. They
 * are separated at all because the columns that matter differ — an IP address
 * and a device tell you about a sign-in and say nothing about an import — and
 * because the sign-in trail is 700 rows deep, so an unsplit list buries every
 * administrative change under a month of logins.
 *
 * The browser trail stays a third tab rather than being merged in. It carries no
 * IP (a page has no access to its own address), it holds only what THIS browser
 * did, it dies with site data, and anyone can rewrite it from devtools. Merging
 * would let the weaker record borrow the authority of the stronger.
 *
 * The server trails page on the server. Paging 200 pre-loaded rows in the
 * browser looks the same until the log passes 200 entries, at which point the
 * older half is simply unreachable and nothing on screen says so.
 */

const AUDIT_POLL_MS = 3000;
const SEARCH_DEBOUNCE_MS = 300;

const TAB_AUTH = "auth";
const TAB_ACTION = "action";
const TAB_LOCAL = "local";

const OUTCOME_TONE = {
  success: { color: "#047857", label: "Success" },
  failed: { color: "#b91c1c", label: "Failed" },
  blocked: { color: "#b45309", label: "Blocked" },
};

function OutcomeBadge({ outcome }) {
  const tone = OUTCOME_TONE[String(outcome || "").toLowerCase()] || { color: "#64748b", label: outcome || "-" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      {/* Dot plus word: the state never rests on colour alone. */}
      <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.color, flex: "none" }} />
      <span style={{ color: tone.color, fontWeight: 600, fontSize: 11 }}>{tone.label}</span>
    </span>
  );
}

/**
 * `user_permissions_updated` -> `User permissions updated`.
 *
 * The stored value is the machine's name for the event, and it is what the
 * filter sends back, so it is translated for display only. Nothing is mapped by
 * hand: a table of known actions would silently show a new one as a raw slug,
 * and the slugs are already readable once the underscores are gone.
 */
/*
 * Action naming and grouping moved to shared/lib/auditActions.js.
 *
 * What was here swapped underscores for spaces, which read correctly only
 * because the identifiers happened to be English in the right order -- and gave
 * "Settings update" and "User inactivated" where they were not. It also had
 * nothing to say about what KIND of event a row was, which is what makes a page
 * of forty of them scannable.
 */

/** The action, with the kind of event it is shown beside it. */
function ActionCell({ action }) {
  const category = AUDIT_CATEGORIES[actionCategory(action)] || AUDIT_CATEGORIES.other;
  const colours = tone(category.tone);

  return (
    <span style={{ display: "grid", gap: 3 }}>
      <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{describeAction(action)}</span>
      <span
        style={{
          justifySelf: "start",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.03em",
          textTransform: "uppercase",
          padding: "1px 6px",
          borderRadius: 999,
          background: colours.bg,
          color: colours.text,
        }}
      >
        {category.label}
      </span>
    </span>
  );
}

/**
 * The sentence, and the recorded fields under it.
 *
 * The fields used to be JSON appended to the sentence and stored in the same
 * varchar(255), so what a reader saw was prose with a half-finished object stuck
 * to the end of it. They live in their own column now, and render as fields.
 */
function DetailCell({ row }) {
  const fields = metadataFields(row.metadata);

  return (
    <span style={{ display: "grid", gap: 5, minWidth: 260, lineHeight: 1.5 }}>
      <span>{row.detail || "—"}</span>
      {fields.length ? (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {fields.map((field) => (
            <span
              key={field.key}
              style={{
                fontSize: 10.5,
                padding: "1px 7px",
                borderRadius: 999,
                border: "1px solid var(--border-base)",
                color: "var(--text-secondary)",
                background: "var(--surface-muted, #f8fafc)",
              }}
            >
              <span style={{ color: "var(--text-muted)" }}>{field.label}: </span>
              {field.value}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

const filterControlStyle = {
  border: "1px solid var(--border-base)",
  borderRadius: 8,
  padding: "7px 9px",
  fontSize: 11.5,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
};

/** The quick ranges, as offsets rather than dates, so they stay right at midnight. */
const DATE_PRESETS = [
  { key: "today", label: "Today", from: () => localDateIsoDaysAgo(0), to: () => localDateIsoDaysAgo(0) },
  { key: "7d", label: "Last 7 days", from: () => localDateIsoDaysAgo(6), to: () => "" },
  { key: "30d", label: "Last 30 days", from: () => localDateIsoDaysAgo(29), to: () => "" },
];

export default function AuditLogsPanel({ logs, onRefresh, onClear, loading = false }) {
  const [tab, setTab] = useState(TAB_AUTH);

  /* ------------------------------------------------------- server trails */
  const [serverRows, setServerRows] = useState([]);
  const [serverStats, setServerStats] = useState(null);
  const [actionFacets, setActionFacets] = useState([]);
  const [total, setTotal] = useState(0);
  const [serverLoading, setServerLoading] = useState(true);
  const [serverError, setServerError] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [live, setLive] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [pendingUpdate, setPendingUpdate] = useState(false);

  const isLocalTab = tab === TAB_LOCAL;

  /*
   * Every filter goes back to page 1, and does it in the SAME update as the
   * change itself.
   *
   * This used to be an effect on the filter values, and that fired two requests
   * for one change — the first of them wrong. Effects for a commit all run
   * before React processes state set inside one, so changing a filter while on
   * page 3 ran `setPage(1)` and the fetch in the same flush: the fetch went out
   * with the new filter and the OLD page, then again with page 1. A page of
   * results nobody asked for was rendered on the way through, and the log was
   * queried twice for every keystroke-settle, dropdown and date.
   *
   * React 19 batches these into one render, so one change is one request.
   */
  const applyFilter = useCallback((setter, value) => {
    setter(value);
    setPage(1);
  }, []);

  // Typing sends one request when you stop, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /*
   * Switching tabs clears the action filter along with the page.
   *
   * The chosen action belongs to the tab it was chosen in: `user_created` is not
   * an option in the sign-in trail, so carrying it across would leave the other
   * tab filtered to nothing by a control whose effect the reader cannot see.
   */
  const changeTab = useCallback((nextTab) => {
    setTab(nextTab);
    setAction("");
    setPage(1);
  }, []);

  /*
   * `silent` keeps the table on screen during an automatic refresh. Flipping
   * the loading flag every three seconds would blank the rows and reset the
   * scroll position under someone reading them.
   */
  const loadServerLog = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setServerLoading(true);
    setServerError("");
    try {
      /*
       * On the browser tab the rows are not used — only the per-tab counts in
       * `stats` are — so it asks for one row instead of a page of twenty it
       * would throw away. `category` is sent only when it names a real trail:
       * "local" is not one, and the endpoint would read it as "everything".
       */
      const params = new URLSearchParams({ page: String(page), limit: isLocalTab ? "1" : String(pageSize) });
      if (!isLocalTab) params.set("category", tab);
      if (search) params.set("search", search);
      if (outcome) params.set("outcome", outcome);
      if (action) params.set("action", action);
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const res = await fetch(getBackendUrl(`audit_log.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load the audit log");

      setServerRows(Array.isArray(json?.data) ? json.data : []);
      setServerStats(json?.stats || null);
      setActionFacets(Array.isArray(json?.actions) ? json.actions : []);
      setTotal(Number(json?.pagination?.total) || 0);
      setLastSyncedAt(Date.now());
      setPendingUpdate(false);
    } catch (error) {
      // A failed silent poll keeps the rows already on screen: a dropped probe
      // is not evidence that the log is empty.
      if (!silent) {
        setServerRows([]);
        setServerStats(null);
        setTotal(0);
      }
      setServerError(error?.message || "Failed to load the audit log");
    } finally {
      if (!silent) setServerLoading(false);
    }
  }, [action, from, isLocalTab, outcome, page, pageSize, search, tab, to]);

  useEffect(() => {
    // The browser tab needs nothing from the server, but the tab counts do, so
    // the request still runs — it is the same one, and it is small.
    void loadServerLog();
  }, [loadServerLog]);

  /*
   * Polls a version token every 3 seconds, not the log itself. changes.php
   * answers in a few dozen bytes -- for this table COUNT(*) plus MAX(audit_id),
   * which MariaDB serves from the index without touching a row -- so the page
   * is refetched only when the token actually moves.
   *
   * What happens on a move depends on where the reader is. New events land at
   * the top, so on page 1 they can simply appear. Past page 1 they would push
   * every row down one position mid-read, silently changing what is under the
   * cursor, so the page is left alone and the arrival is offered instead.
   */
  const pageRef = useRef(page);
  pageRef.current = page;

  useLiveRefresh(
    "audit_log",
    useCallback(() => {
      if (pageRef.current === 1) {
        void loadServerLog({ silent: true });
      } else {
        setPendingUpdate(true);
      }
    }, [loadServerLog]),
    { intervalMs: AUDIT_POLL_MS, enabled: live && !isLocalTab }
  );

  /* --------------------------------------------------------------- columns */
  // The stamp, the role and the badges hold one line; Detail is the prose in
  // these tables and keeps the room a wrapped timestamp used to take from it.
  const timeColumn = { key: "occurred_at", label: "Time", nowrap: true, render: (row) => formatWhen(row.occurred_at) };
  const whoColumns = [
    { key: "user", label: "User" },
    { key: "role_name", label: "Role", nowrap: true, render: (row) => row.role_name || "-" },
  ];

  const authColumns = [
    timeColumn,
    ...whoColumns,
    { key: "action", label: "Action", nowrap: true, render: (row) => <ActionCell action={row.action} /> },
    { key: "outcome", label: "Outcome", nowrap: true, render: (row) => <OutcomeBadge outcome={row.outcome} /> },
    {
      key: "ip_address",
      label: "IP Address",
      nowrap: true,
      render: (row) => (
        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}>
          {row.ip_address || "-"}
        </span>
      ),
    },
    {
      key: "device",
      label: "Device",
      // The full User-Agent is the tooltip: useful when the summary is wrong,
      // noise the other 99% of the time.
      render: (row) => <span title={row.user_agent || ""}>{row.device || "-"}</span>,
    },
    { key: "detail", label: "Detail", render: (row) => row.detail || "-" },
  ];

  /*
   * No IP or Device column here, and Detail is given the room they were using.
   *
   * An action row's detail is the event — "Changed role, department for user
   * X", "Imported grades from sheet.xls into 1st Semester 2026-2027: 312
   * updated" — and truncating that to share a row with an address the change did
   * not depend on gets the priority backwards.
   */
  const actionColumns = [
    timeColumn,
    ...whoColumns,
    { key: "action", label: "Action", nowrap: true, render: (row) => <ActionCell action={row.action} /> },
    {
      key: "detail",
      label: "What changed",
      render: (row) => <DetailCell row={row} />,
    },
  ];

  /* ------------------------------------------------- local browser trail */
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(10);

  const localRows = useMemo(() => {
    return (Array.isArray(logs) ? logs : []).map((log) => ({
      id: log.id,
      timestamp: new Date(log.timestamp).toLocaleString(),
      user: log.email || `User ${log.user_id ?? ""}`.trim(),
      role: log.role_name || "-",
      action: log.action,
      detail: log.detail || "-",
    }));
  }, [logs]);

  useEffect(() => {
    const pageCount = Math.max(1, Math.ceil(localRows.length / localPageSize));
    setLocalPage((current) => Math.min(current, pageCount));
  }, [localRows.length, localPageSize]);

  const pagedLocalRows = useMemo(() => {
    const start = (localPage - 1) * localPageSize;
    return localRows.slice(start, start + localPageSize);
  }, [localPage, localPageSize, localRows]);

  const localColumns = [
    { key: "timestamp", label: "Time", nowrap: true },
    { key: "user", label: "User" },
    { key: "role", label: "Role", nowrap: true },
    { key: "action", label: "Action", nowrap: true },
    { key: "detail", label: "Detail" },
  ];

  /* ----------------------------------------------------------- assembled */
  const hasFilters = Boolean(search || outcome || action || from || to);

  /* ------------------------------------------------------------- export */

  /**
   * What the file should be called, and what it says it contains.
   *
   * The filters are in the name because an audit export is evidence: a folder
   * holding `audit-actions-failed-2026-08-26.xls` beside
   * `audit-sign-ins-2026-08-26.xls` can be told apart months later, whereas two
   * files both called `audit.xls` cannot, and nothing inside either one records
   * what was filtered out.
   */
  const exportFileName = useMemo(() => {
    const parts = ["audit", tab === TAB_AUTH ? "sign-ins" : tab === TAB_ACTION ? "actions" : "this-browser"];
    if (action) parts.push(action);
    if (outcome) parts.push(outcome);
    if (from || to) parts.push(`${from || "start"}_to_${to || "today"}`);
    if (search) parts.push("filtered");
    return parts.join("-");
  }, [action, from, outcome, search, tab, to]);

  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");

  /*
   * Plain values, not the cells.
   *
   * The table's columns render React elements — a coloured OutcomeBadge, a
   * monospaced address, a tooltip-carrying device — and a spreadsheet cannot
   * hold any of that. The export declares its own columns so a row lands as
   * text, and it carries the full User-Agent rather than the shortened device
   * summary: in a file being kept as evidence, the long form is the useful one.
   */
  const EXPORT_COLUMNS = {
    [TAB_AUTH]: [
      { key: "occurred_at", label: "Time" },
      { key: "user", label: "User" },
      { key: "role_name", label: "Role" },
      { key: "action", label: "Action" },
      { key: "outcome", label: "Outcome" },
      { key: "ip_address", label: "IP Address" },
      { key: "device", label: "Device" },
      { key: "user_agent", label: "User Agent" },
      { key: "detail", label: "Detail" },
    ],
    [TAB_ACTION]: [
      { key: "occurred_at", label: "Time" },
      { key: "user", label: "User" },
      { key: "role_name", label: "Role" },
      { key: "category", label: "Type" },
      { key: "action", label: "Action" },
      { key: "detail", label: "What Changed" },
      // The recorded fields, flattened. Without this the export is strictly
      // less than the screen: the metadata is visible in the table and would
      // be missing from the file somebody actually files.
      { key: "recorded_fields", label: "Recorded Details" },
      { key: "ip_address", label: "IP Address" },
    ],
    [TAB_LOCAL]: [
      { key: "timestamp", label: "Time" },
      { key: "user", label: "User" },
      { key: "role", label: "Role" },
      { key: "action", label: "Action" },
      { key: "detail", label: "Detail" },
    ],
  };

  /**
   * Every row matching the current filters — not the page on screen.
   *
   * This is the difference between an export and a screenshot. The table shows
   * twenty rows; the file has to hold all 705 sign-ins the filter matched, so it
   * walks the server's pages the same way the Reports module's export does.
   *
   * The ceiling is deliberate and is reported rather than hidden. A silently
   * truncated audit export is the worst possible kind: it opens cleanly, every
   * row in it is genuine, and the missing ones leave no trace — which is exactly
   * the failure the sheet importers had.
   */
  const EXPORT_PAGE_SIZE = 500;
  const EXPORT_MAX_ROWS = 20000;

  const fetchAllAuditRows = useCallback(async () => {
    const collected = [];
    let nextPage = 1;

    while (collected.length < EXPORT_MAX_ROWS) {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: String(EXPORT_PAGE_SIZE),
        category: tab,
      });
      if (search) params.set("search", search);
      if (outcome) params.set("outcome", outcome);
      if (action) params.set("action", action);
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const res = await fetch(getBackendUrl(`audit_log.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to read the audit log for export");

      const batch = Array.isArray(json?.data) ? json.data : [];
      collected.push(...batch);

      const matched = Number(json?.pagination?.total) || 0;
      if (batch.length < EXPORT_PAGE_SIZE || collected.length >= matched) break;
      nextPage += 1;
    }

    return collected;
  }, [action, from, outcome, search, tab, to]);

  const runExport = useCallback(
    async (format) => {
      setExporting(format);
      setExportError("");
      try {
        // The browser trail is already fully in memory and has no server to
        // page through, so it exports what it holds.
        const rows = isLocalTab
          ? localRows
          : (await fetchAllAuditRows()).map((row) => ({
              ...row,
              occurred_at: formatWhen(row.occurred_at),
              category: (AUDIT_CATEGORIES[actionCategory(row.action)] || AUDIT_CATEGORIES.other).label,
              action: describeAction(row.action),
              outcome: OUTCOME_TONE[String(row.outcome || "").toLowerCase()]?.label || row.outcome || "",
              recorded_fields: metadataFields(row.metadata)
                .map((field) => `${field.label}: ${field.value}`)
                .join("; "),
            }));

        const wrote = exportTable(format, {
          filename: exportFileName,
          sheet: tab === TAB_AUTH ? "Sign-in Activity" : tab === TAB_ACTION ? "Actions" : "This Browser",
          columns: EXPORT_COLUMNS[tab],
          rows,
        });

        // exportTable returns false rather than handing over a file of nothing
        // but headers, which reads as a broken export instead of an empty one.
        if (!wrote) {
          setExportError(
            hasFilters
              ? "Nothing matches these filters, so there is nothing to export."
              : "This trail has no entries to export."
          );
        }
      } catch (error) {
        setExportError(error?.message || "Export failed.");
      } finally {
        setExporting("");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exportFileName, fetchAllAuditRows, hasFilters, isLocalTab, localRows, tab]
  );


  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setOutcome("");
    setAction("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  function applyPreset(preset) {
    setFrom(preset.from());
    setTo(preset.to());
    setPage(1);
  }

  const activePreset = DATE_PRESETS.find((preset) => preset.from() === from && preset.to() === to)?.key || "";

  const tabs = [
    { key: TAB_AUTH, label: "Sign-in activity", count: serverStats?.auth_total, hint: "Logins, logouts and failed attempts" },
    { key: TAB_ACTION, label: "Actions", count: serverStats?.action_total, hint: "Changes people made — accounts, permissions, imports, restores" },
    { key: TAB_LOCAL, label: "This browser", count: localRows.length, hint: "The local trail kept in this browser only" },
  ];

  return (
    <DashboardPanel>
      <SectionHeader
        title="Audit Log"
        actions={
          isLocalTab ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <ExportMenu
                options={TABLE_EXPORT_FORMATS}
                busyKey={exporting}
                onSelect={runExport}
                disabled={localRows.length === 0}
              />
              <Button variant="secondary" onClick={onRefresh}>Refresh</Button>
              <Button variant="danger" onClick={onClear}>Clear Logs</Button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Says both that it is live and when it last agreed with the
                  server, so a quiet log reads as "nothing happened" rather
                  than as "this stopped working". */}
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
                <span
                  aria-hidden="true"
                  style={{ width: 7, height: 7, borderRadius: 999, background: live ? "#047857" : "#94a3b8", flex: "none" }}
                />
                {live ? "Live" : "Paused"}
              </label>
              {lastSyncedAt ? (
                <span style={{ fontSize: 10.5, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                  synced {new Date(lastSyncedAt).toLocaleTimeString()}
                </span>
              ) : null}
              {/* Exports what the filters match, not the page on screen —
                  see fetchAllAuditRows. */}
              <ExportMenu
                options={TABLE_EXPORT_FORMATS}
                busyKey={exporting}
                onSelect={runExport}
                disabled={serverLoading || total === 0}
              />
              <Button variant="secondary" onClick={() => void loadServerLog()} disabled={serverLoading}>
                Refresh
              </Button>
            </div>
          )
        }
      />

      <div style={{ padding: 9, display: "grid", gap: 9 }}>
        <Tabs tabs={tabs} value={tab} onChange={changeTab} variant="underline" label="Audit trails" />

        {serverError && !isLocalTab ? (
          <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
            {serverError}
          </div>
        ) : null}

        {/* Shown on every tab, because the export is offered on every tab. */}
        {exportError ? (
          <div role="alert" style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
            {exportError}
          </div>
        ) : null}

        {isLocalTab ? (
          <>
            <p style={{ margin: 0, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              In-app actions kept in this browser only. It carries no IP address, does not include what other people did,
              and is cleared with your site data — useful as a local trace, not as a record of record. What the server
              recorded is under <strong>Actions</strong>.
            </p>

            <Table columns={localColumns} rows={pagedLocalRows} loading={loading} emptyText="No local actions recorded yet." />

            {/* Same component as the server trails. This list is already fully
                in memory, so it pages client-side -- but it should not look like
                a different control just because the data got there a different
                way. */}
            <Pagination
              page={localPage}
              pageSize={localPageSize}
              total={localRows.length}
              onPageChange={setLocalPage}
              onPageSizeChange={setLocalPageSize}
              pageSizeOptions={[10, 25, 50]}
              itemLabel="actions"
            />
          </>
        ) : (
          <>
            {/*
              * What the summary answers, in the order somebody asks it.
              *
              * "Recorded Events" used to lead, and it is the least useful number
              * here: a lifetime total only ever climbs, so it says nothing about
              * whether anything has happened. Recent activity leads instead, and
              * the lifetime total moves to the end as context.
              */}
            <StatCardGrid minWidth={190}>
              <StatCard
                label="Last 24 hours"
                value={serverLoading ? "..." : (serverStats?.recent_24h ?? 0).toLocaleString()}
                meta={tab === TAB_AUTH ? "sign-in events" : "changes recorded"}
              />
              {tab === TAB_AUTH ? (
                <StatCard
                  label="Failed Sign-ins (24h)"
                  value={serverLoading ? "..." : serverStats?.failed_logins_24h ?? 0}
                  tone={(serverStats?.failed_logins_24h ?? 0) > 0 ? "danger" : undefined}
                  meta={(serverStats?.failed_logins_24h ?? 0) > 0 ? "worth a look" : "nothing refused"}
                />
              ) : (
                <StatCard
                  label="Busiest This Week"
                  value={serverLoading ? "..." : serverStats?.busiest_actor || "—"}
                  meta={
                    serverStats?.busiest_actor
                      ? `${(serverStats.busiest_actor_records ?? 0).toLocaleString()} changes`
                      : "no changes recorded"
                  }
                />
              )}
              <StatCard
                label={hasFilters ? "Matching Filters" : "In This Tab"}
                value={serverLoading ? "..." : total.toLocaleString()}
                meta={
                  hasFilters
                    ? `of ${(tab === TAB_AUTH ? serverStats?.auth_total : serverStats?.action_total ?? 0) || 0} recorded`
                    : `${(serverStats?.total ?? 0).toLocaleString()} in the whole log`
                }
              />
            </StatCardGrid>

            {/* One filter row above what it scopes. All of them go to the
                server, so they search the whole log rather than the page on
                screen. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder={
                  tab === TAB_AUTH
                    ? "Search by user, IP address or device..."
                    : "Search by user, or by what changed..."
                }
                style={{ ...filterControlStyle, flex: "1 1 240px", minWidth: 0 }}
                aria-label="Search the audit log"
              />

              <select
                value={action}
                onChange={(event) => applyFilter(setAction, event.target.value)}
                style={{ ...filterControlStyle, maxWidth: 230 }}
                aria-label="Filter by action"
              >
                <option value="">All actions</option>
                {actionFacets.map((facet) => (
                  <option key={facet.action} value={facet.action}>
                    {describeAction(facet.action)} ({facet.records.toLocaleString()})
                  </option>
                ))}
              </select>

              {/* Outcome is offered only where it varies. Every action row is a
                  change that went through — a failed one threw before it was
                  recorded — so the control would be a dropdown with one real
                  answer, which reads as a filter that does not work. */}
              {tab === TAB_AUTH ? (
                <select
                  value={outcome}
                  onChange={(event) => applyFilter(setOutcome, event.target.value)}
                  style={{ ...filterControlStyle, maxWidth: 160 }}
                  aria-label="Filter by outcome"
                >
                  <option value="">All outcomes</option>
                  <option value="success">Success</option>
                  <option value="failed">Failed</option>
                  <option value="blocked">Blocked</option>
                </select>
              ) : null}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Between</span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => applyFilter(setFrom, event.target.value)}
                style={{ ...filterControlStyle, colorScheme: "light" }}
                aria-label="Show events from this date"
              />
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>and</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => applyFilter(setTo, event.target.value)}
                style={{ ...filterControlStyle, colorScheme: "light" }}
                aria-label="Show events up to this date"
              />

              {DATE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  style={{
                    ...filterControlStyle,
                    cursor: "pointer",
                    fontWeight: activePreset === preset.key ? 600 : 400,
                    background: activePreset === preset.key ? "var(--brand-50)" : "var(--surface-base)",
                    borderColor: activePreset === preset.key ? "var(--brand-200)" : "var(--border-base)",
                    color: activePreset === preset.key ? "var(--brand-800)" : "var(--text-secondary)",
                  }}
                >
                  {preset.label}
                </button>
              ))}

              {hasFilters ? (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>

            {pendingUpdate ? (
              <button
                type="button"
                onClick={() => setPage(1)}
                style={{
                  border: "1px solid var(--brand-200)",
                  background: "var(--brand-50)",
                  color: "var(--brand-800)",
                  borderRadius: 8,
                  padding: "7px 9px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                New activity recorded. Jump to the latest &rarr;
              </button>
            ) : null}

            <Table
              columns={tab === TAB_AUTH ? authColumns : actionColumns}
              rows={serverRows}
              loading={serverLoading}
              emptyText={
                hasFilters
                  ? "Nothing in this trail matches these filters."
                  : tab === TAB_AUTH
                    ? "No sign-in activity recorded yet. Events appear here as people log in and out."
                    : "No changes recorded yet. Account edits, permission changes, imports and restores appear here as they happen."
              }
            />

            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              // Rows-per-page resets to page 1 like any other filter: page 7 of
              // 20-row pages is off the end at 100 per page.
              onPageSizeChange={(size) => applyFilter(setPageSize, size)}
              pageSizeOptions={[20, 50, 100]}
              itemLabel="events"
            />

            <p style={{ margin: 0, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {tab === TAB_AUTH
                ? "Recorded by the server as each event happens, so these rows cover every user and cannot be edited from a browser. An address of 127.0.0.1 means the portal was opened on the machine running it."
                : "Recorded by the server as each change is made, so these rows cover every user and cannot be edited from a browser. Student records created by an import are not listed individually — the import itself is one row."}
            </p>
          </>
        )}
      </div>
    </DashboardPanel>
  );
}
