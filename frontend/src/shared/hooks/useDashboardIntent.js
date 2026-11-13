import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { persistDashboardIntent, readDashboardIntent } from "../lib/dashboardIntent";

export default function useDashboardIntent({
  onView,
  onReport,
  onSection,
  activeView,
  activeReport,
  activeSection,
  persist = false,
} = {}) {
  const location = useLocation();
  const intent = useMemo(() => readDashboardIntent(location.search), [location.search]);

  useEffect(() => {
    if (intent.view && typeof onView === "function") {
      onView(intent.view);
    }
  }, [intent.view, onView]);

  useEffect(() => {
    if (intent.report && typeof onReport === "function") {
      onReport(intent.report);
    }
  }, [intent.report, onReport]);

  useEffect(() => {
    if (intent.section && typeof onSection === "function") {
      onSection(intent.section);
    }
  }, [intent.section, onSection]);

  useEffect(() => {
    if (!persist) return;

    const updates = {};
    if (activeView !== undefined) {
      updates.view = activeView;
    }
    if (activeReport !== undefined) {
      updates.report = activeReport;
    }
    if (activeSection !== undefined) {
      updates.section = activeSection;
    }

    if (Object.keys(updates).length > 0) {
      persistDashboardIntent(updates, location.pathname);
    }
  }, [activeReport, activeSection, activeView, location.pathname, persist]);

  return intent;
}
