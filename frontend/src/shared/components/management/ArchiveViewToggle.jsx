import React from "react";
import Button from "../ui/Button";
import Icon from "../ui/Icon";

export default function ArchiveViewToggle({
  view = "active",
  onChange,
  activeLabel = "Active",
  archivedLabel = "Archived",
  size = "sm",
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <Button
        type="button"
        size={size}
        variant={view === "active" ? "primary" : "secondary"}
        onClick={() => onChange?.("active")}
      >
        <Icon name="archiveRestore" size={12} />
        <span>{activeLabel}</span>
      </Button>
      <Button
        type="button"
        size={size}
        variant="secondary"
        onClick={() => onChange?.("archived")}
        className={view === "archived" ? "ui-archive-button" : undefined}
      >
        <Icon name="archive" size={12} />
        <span>{archivedLabel}</span>
      </Button>
    </div>
  );
}
