import React from "react";
import { OverviewHeader } from "../../shared/layout/dashboard";
import AssignmentsWorkspace from "./AssignmentsWorkspace";

/**
 * Module-page wrapper for the SSP assignment board.
 *
 * Registered in MODULE_COMPONENTS so any role granted `assignments` — not just
 * the SSP Coordinator dashboard that originally owned the markup — opens the
 * real workspace instead of the "not wired yet" placeholder.
 */
export default function AssignmentsPage({ permissions = [] }) {
  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <OverviewHeader
        title="Student Assignments"
        subtitle="Assign students needing enrollment follow-up to a coach. STAR students go to KASAMA coaches, Non-STAR students to SSP coaches."
      />
      <AssignmentsWorkspace permissions={permissions} />
    </section>
  );
}
