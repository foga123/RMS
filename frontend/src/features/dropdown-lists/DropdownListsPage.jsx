import React, { useCallback, useEffect, useMemo, useState } from "react";
// The file, not the barrel: the barrel also exports AdminOverviewWorkspace,
// which would pull the whole dashboard shell into this page's lazy chunk.
import { ManagementPage } from "../../shared/components/management/ManagementPage";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import Badge from "../../shared/components/ui/Badge";
import Button from "../../shared/components/ui/Button";
import Icon from "../../shared/components/ui/Icon";
import SectionHeader from "../../shared/components/ui/SectionHeader";
import Tabs from "../../shared/components/ui/Tabs";
import Table from "../../shared/components/Table/Table";
import { InputControl } from "../../shared/components/Form/Form";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import { confirmAction } from "../../shared/lib/notify";
import { loadDropdownOptions } from "../../shared/lib/dropdownOptions";
import { getBackendUrl } from "../../shared/lib/url";

/**
 * Dropdown Management: the lists the forms offer, edited in one place.
 *
 * Every list is described on the server (backend lib/dropdown_lists.php) and
 * this screen is written once against that description - it has no idea which
 * lists exist until it asks. A list added there appears here as another tab.
 *
 * What it will not do, on purpose:
 *   - delete. An entry is archived: records that already hold it keep it and
 *     still show it, and it stops being offered on new forms.
 *   - archive a locked entry, one the system itself writes (Home Visit, F2F,
 *     the default modality). The server refuses; the button is not offered.
 *
 * Access is the dropdown_lists module, granted per role or user in Access
 * Management. The server says what this account may do with each list, and
 * that answer - not the module prop - decides which buttons appear.
 */

async function requestJson(path, options = {}) {
  const res = await fetch(getBackendUrl(path), {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || "The request failed.");
  }
  return data;
}

const emptyDraft = { text: "", group: "", flags: {} };

/** What renaming does, per shape - said beside the list so nobody is surprised. */
function renameNote(list) {
  if (!list) return "";
  if (list.shape === "name") {
    return "Renaming an entry renames it on every record that already holds it.";
  }
  return "Renaming an entry changes its wording everywhere; records keep pointing at it.";
}

export default function DropdownListsPage() {
  const beginListsRequest = useLatestRequest();
  const beginItemsRequest = useLatestRequest();

  const [lists, setLists] = useState([]);
  const [listKey, setListKey] = useState("");
  const [items, setItems] = useState([]);
  const [can, setCan] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [view, setView] = useState("active");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(null);
  const [editing, setEditing] = useState(null);

  const list = useMemo(() => lists.find((entry) => entry.key === listKey) || null, [lists, listKey]);

  const loadLists = useCallback(async () => {
    const isCurrent = beginListsRequest();
    try {
      const data = await requestJson("dropdown_list.php");
      if (!isCurrent()) return;
      const next = Array.isArray(data?.lists) ? data.lists : [];
      setLists(next);
      setCan(data?.permissions || {});
      setListKey((current) => current || next[0]?.key || "");
    } catch (e) {
      if (isCurrent()) setError(e.message);
    }
  }, [beginListsRequest]);

  const loadItems = useCallback(async () => {
    if (!listKey) return;
    const isCurrent = beginItemsRequest();
    setLoading(true);
    try {
      const data = await requestJson(`dropdown_list.php?list=${encodeURIComponent(listKey)}`);
      if (!isCurrent()) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setCan(data?.permissions || {});
      if (data?.list) {
        setLists((current) => current.map((entry) => (entry.key === data.list.key ? data.list : entry)));
      }
    } catch (e) {
      if (!isCurrent()) return;
      setItems([]);
      setError(e.message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginItemsRequest, listKey]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    setAdding(null);
    setEditing(null);
    setSearch("");
    void loadItems();
  }, [loadItems]);

  /** Run a write, then reload this list and refresh the forms' copy in this tab. */
  async function write(path, options, message) {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const data = await requestJson(path, options);
      setSuccess(message || data?.message || "Saved.");
      await loadItems();
      // Forms opened in this tab from now on see the change without a reload.
      loadDropdownOptions().catch(() => {});
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const listPath = `dropdown_list.php?list=${encodeURIComponent(listKey)}`;

  async function saveNew() {
    const ok = await write(listPath, { method: "POST", body: JSON.stringify(adding) });
    if (ok) setAdding(null);
  }

  async function saveEdit() {
    const ok = await write(listPath, {
      method: "PUT",
      body: JSON.stringify({ action: "update", ...editing }),
    });
    if (ok) setEditing(null);
  }

  async function setActive(item, active) {
    if (!active) {
      const confirmed = await confirmAction({
        title: `Archive "${item.text}"?`,
        text: item.in_use > 0
          ? `It stops being offered on forms. The ${item.in_use} record${item.in_use === 1 ? "" : "s"} that already hold it keep it.`
          : "It stops being offered on forms. You can restore it at any time.",
        confirmButtonText: "Archive",
      });
      if (!confirmed) return;
    }
    await write(listPath, {
      method: "PUT",
      body: JSON.stringify({ action: active ? "restore" : "archive", id: item.id }),
    });
  }

  const activeItems = useMemo(() => items.filter((item) => item.active), [items]);

  /**
   * Swap an entry with its neighbour. Within a category when the list has
   * categories, because that is how the dropdown groups them - moving a reason
   * past another category's entries would change nothing a caller sees.
   */
  async function move(item, direction) {
    const order = activeItems.map((entry) => entry.id);
    const from = order.indexOf(item.id);
    let to = from + direction;
    if (list?.group) {
      while (to >= 0 && to < activeItems.length && activeItems[to].group !== item.group) {
        to += direction;
      }
    }
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    await write(listPath, { method: "PUT", body: JSON.stringify({ action: "reorder", ids: order }) }, "Order saved.");
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((item) => (view === "active" ? item.active : !item.active))
      .filter((item) => !q || item.text.toLowerCase().includes(q) || String(item.group || "").toLowerCase().includes(q));
  }, [items, view, search]);

  const groupSuggestions = useMemo(
    () => Array.from(new Set(items.map((item) => item.group).filter(Boolean))),
    [items]
  );

  const canReorder = Boolean(can.edit) && view === "active" && !search.trim();
  const flagEntries = Object.entries(list?.flags || {});
  const groupListId = `dropdown-groups-${listKey}`;

  const draftFields = (draft, setDraft) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <InputControl
        value={draft.text}
        onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        placeholder={list ? `The ${list.noun}, as it should read on the form` : ""}
        maxLength={list?.max_length}
        style={{ flex: "2 1 260px" }}
        aria-label={list ? `${list.noun} wording` : "wording"}
      />
      {list?.group ? (
        <>
          <InputControl
            value={draft.group}
            onChange={(e) => setDraft((d) => ({ ...d, group: e.target.value }))}
            placeholder={list.group.label}
            maxLength={list.group.max_length}
            list={groupListId}
            style={{ flex: "1 1 160px" }}
            aria-label={list.group.label}
          />
          <datalist id={groupListId}>
            {groupSuggestions.map((group) => <option key={group} value={group} />)}
          </datalist>
        </>
      ) : null}
      {flagEntries.map(([flag, label]) => (
        <label key={flag} style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={Boolean(draft.flags?.[flag])}
            onChange={(e) => setDraft((d) => ({ ...d, flags: { ...(d.flags || {}), [flag]: e.target.checked } }))}
          />
          {label}
        </label>
      ))}
    </div>
  );

  const columns = [
    ...(canReorder
      ? [{
          key: "order",
          label: "Order",
          nowrap: true,
          render: (item) => (
            <span style={{ display: "inline-flex", gap: 2 }}>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => move(item, -1)} aria-label={`Move "${item.text}" up`}>↑</Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => move(item, 1)} aria-label={`Move "${item.text}" down`}>↓</Button>
            </span>
          ),
        }]
      : []),
    {
      key: "text",
      label: list ? list.noun.charAt(0).toUpperCase() + list.noun.slice(1) : "Entry",
      render: (item) =>
        editing?.id === item.id ? (
          draftFields(editing, setEditing)
        ) : (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>{item.text}</span>
            {item.locked ? (
              <span title="The system itself uses this entry, so it cannot be archived.">
                <Badge tone="neutral"><Icon name="lock" size={10} /> Used by the system</Badge>
              </span>
            ) : null}
          </span>
        ),
    },
    ...(list?.group && !editing
      ? [{ key: "group", label: list.group.label, render: (item) => item.group }]
      : []),
    ...(flagEntries.length && !editing
      ? flagEntries.map(([flag, label]) => ({
          key: `flag_${flag}`,
          label,
          render: (item) => (item.flags?.[flag] ? <Badge tone="brand">Yes</Badge> : <span style={{ color: "var(--text-muted)" }}>No</span>),
        }))
      : []),
    {
      key: "in_use",
      label: "In use",
      nowrap: true,
      render: (item) => (item.in_use > 0 ? `${item.in_use} record${item.in_use === 1 ? "" : "s"}` : <span style={{ color: "var(--text-muted)" }}>Not yet</span>),
    },
    {
      key: "actions",
      label: "",
      nowrap: true,
      render: (item) => {
        if (editing?.id === item.id) {
          return (
            <span style={{ display: "inline-flex", gap: 4 }}>
              <Button size="sm" disabled={saving} onClick={saveEdit}><Icon name="check" size={12} /><span>Save</span></Button>
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button>
            </span>
          );
        }
        // A locked name-shaped entry is the value the system writes: it can
        // be neither reworded nor archived, so it offers nothing.
        const canRename = can.edit && !(item.locked && list?.shape === "name");
        return (
          <span style={{ display: "inline-flex", gap: 4 }}>
            {item.active && canRename ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setAdding(null);
                  setEditing({ id: item.id, text: item.text, group: item.group || "", flags: { ...(item.flags || {}) } });
                }}
              >
                <Icon name="edit" size={12} /><span>Edit</span>
              </Button>
            ) : null}
            {item.active && can.archive && !item.locked ? (
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => setActive(item, false)}>
                <Icon name="archive" size={12} /><span>Archive</span>
              </Button>
            ) : null}
            {!item.active && can.restore ? (
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => setActive(item, true)}>
                <Icon name="archiveRestore" size={12} /><span>Restore</span>
              </Button>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <ManagementPage
      title="Dropdown Management"
      subtitle="The lists the forms offer. A change reaches every form the next time it is opened."
      error={error}
      success={success}
    >
      <Tabs
        label="Dropdown lists"
        value={listKey}
        onChange={(key) => {
          setError("");
          setSuccess("");
          setView("active");
          setListKey(key);
        }}
        tabs={lists.map((entry) => ({ key: entry.key, label: entry.label, count: entry.counts?.active }))}
        style={{ marginBottom: 9 }}
      />

      {list ? (
        <p style={{ margin: "0 0 9px", color: "var(--text-secondary)", fontSize: 12.5 }}>
          {list.used_by} {renameNote(list)}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 9 }}>
        <InputControl
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this list..."
          style={{ minWidth: 204, flex: "1 1 240px" }}
          aria-label="Search this list"
        />
        <ArchiveViewToggle
          view={view}
          onChange={setView}
          archivedLabel={`Archived${list?.counts?.archived ? ` (${list.counts.archived})` : ""}`}
        />
        {can.create && view === "active" ? (
          <Button
            disabled={saving || !list}
            onClick={() => {
              setEditing(null);
              setAdding({ ...emptyDraft });
            }}
          >
            <Icon name="plus" size={14} /><span>{list ? `Add ${list.noun}` : "Add"}</span>
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div style={{ border: "1px solid var(--border-base)", borderRadius: 9, padding: 9, marginBottom: 9, background: "var(--surface-base)" }}>
          <SectionHeader title={list ? `New ${list.noun}` : "New entry"} />
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <div style={{ flex: "1 1 auto" }}>{draftFields(adding, setAdding)}</div>
            <Button disabled={saving || !adding.text.trim()} onClick={saveNew}><Icon name="check" size={12} /><span>Add</span></Button>
            <Button variant="secondary" disabled={saving} onClick={() => setAdding(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}

      <Table
        columns={columns}
        rows={visible}
        loading={loading}
        emptyText={view === "active" ? "Nothing on this list yet." : "Nothing archived."}
      />

      <p style={{ marginTop: 9, color: "var(--text-muted)", fontSize: 12 }}>
        Account, enrollment and other statuses are managed in Status Management. The retention statuses' wording is in Settings.
        Intervention outcomes, priorities and periods are not listed here: the system acts on each of them, so they are fixed.
      </p>
    </ManagementPage>
  );
}
