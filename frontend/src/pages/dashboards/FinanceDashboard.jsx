import React, { useEffect, useMemo, useState } from "react";
import FinanceManage from "../../features/finance/FinancePage.jsx";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { FinanceLineChart } from "../../shared/components/ui";
import { DashboardShell, OverviewHeader } from "../../shared/layout/dashboard";
import { GrantedModuleSidebarSections, GrantedModuleView } from "./SharedGrantedModules";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "./moduleAccess";
import { hasRole, readAuthUser, replacePath } from "../../shared/lib/auth";
import { getBackendUrl } from "../../shared/lib/url";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";

const DEFAULT_VIEWS = ["overview", "finance_management"];

const currencyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function toLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateKey(rawDate) {
  if (!rawDate) return "";
  const text = String(rawDate).trim();
  const directMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (directMatch) {
    return `${directMatch[1]}-${directMatch[2]}-${directMatch[3]}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return toLocalDateKey(parsed);
}

function toAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
  return currencyFormatter.format(toAmount(value));
}

function buildMonthlyCollections(rows, monthCount = 6) {
  const now = new Date();
  const months = [];

  for (let index = monthCount - 1; index >= 0; index -= 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - index, 1);
    const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
    const shortYear = String(monthDate.getFullYear()).slice(-2);
    const needsYear = monthDate.getFullYear() !== now.getFullYear();
    const label = monthDate.toLocaleString("en-US", { month: "short" }) + (needsYear ? ` '${shortYear}` : "");
    months.push({ key, label });
  }

  const totals = months.reduce((acc, month) => ({ ...acc, [month.key]: 0 }), {});

  rows.forEach((row) => {
    const amount = toAmount(row?.amount ?? row?.balance_to_data);
    const dateKey = normalizeDateKey(row?.date);
    if (!dateKey) return;
    const monthKey = dateKey.slice(0, 7);
    if (Object.prototype.hasOwnProperty.call(totals, monthKey)) {
      totals[monthKey] += amount;
    }
  });

  return months.map((month) => ({
    label: month.label,
    value: Number(totals[month.key].toFixed(2)),
  }));
}

function buildDailyCollections(rows, dayCount = 7) {
  const now = new Date();
  const days = [];

  for (let index = dayCount - 1; index >= 0; index -= 1) {
    const dayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - index);
    const key = toLocalDateKey(dayDate);
    const label = dayDate.toLocaleString("en-US", { month: "short", day: "numeric" });
    days.push({ key, label });
  }

  const totals = days.reduce((acc, day) => ({ ...acc, [day.key]: 0 }), {});

  rows.forEach((row) => {
    const amount = toAmount(row?.amount ?? row?.balance_to_data);
    const dateKey = normalizeDateKey(row?.date);
    if (dateKey && Object.prototype.hasOwnProperty.call(totals, dateKey)) {
      totals[dateKey] += amount;
    }
  });

  return days.map((day) => ({
    label: day.label,
    value: Number(totals[day.key].toFixed(2)),
  }));
}

export default function FinanceDashboard() {
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [financeRows, setFinanceRows] = useState([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  useDashboardIntent({ onView: setActiveView, activeView, persist: true });

  useEffect(() => {
    const parsed = readAuthUser();
    if (!hasRole(parsed, { id: 10, name: "finance" })) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, []);

  useEffect(() => {
    if (!user || activeView !== "overview") return;
    let active = true;

    async function loadFinanceDashboard() {
      setDashboardLoading(true);
      setDashboardError("");
      try {
        const res = await fetch(getBackendUrl("finance.php?action=list"), {
          headers: { Accept: "application/json" },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load finance dashboard");
        const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        if (!active) return;
        setFinanceRows(rows);
      } catch (error) {
        if (!active) return;
        setFinanceRows([]);
        setDashboardError(error?.message || "Failed to load finance dashboard");
      } finally {
        if (active) setDashboardLoading(false);
      }
    }

    void loadFinanceDashboard();
    return () => {
      active = false;
    };
  }, [user, activeView]);

  const metrics = useMemo(() => {
    const todayKey = toLocalDateKey(new Date());
    const monthKey = todayKey.slice(0, 7);
    let totalAmount = 0;
    let todayAmount = 0;
    let monthAmount = 0;
    const uniqueStudents = new Set();

    financeRows.forEach((row) => {
      const amount = toAmount(row?.amount ?? row?.balance_to_data);
      const dateKey = normalizeDateKey(row?.date);
      totalAmount += amount;
      if (dateKey && dateKey === todayKey) todayAmount += amount;
      if (dateKey && dateKey.startsWith(monthKey)) monthAmount += amount;
      if (row?.student_id != null && String(row.student_id).trim() !== "") {
        uniqueStudents.add(String(row.student_id).trim());
      }
    });

    const transactionCount = financeRows.length;
    const avgAmount = transactionCount > 0 ? totalAmount / transactionCount : 0;
    return {
      transactionCount,
      totalAmount,
      todayAmount,
      monthAmount,
      avgAmount,
      uniqueStudents: uniqueStudents.size,
    };
  }, [financeRows]);

  const collectionSnapshot = useMemo(() => ([
    { label: "Total", value: Number(metrics.totalAmount.toFixed(2)) },
    { label: "Today", value: Number(metrics.todayAmount.toFixed(2)) },
    { label: "This Month", value: Number(metrics.monthAmount.toFixed(2)) },
    { label: "Average", value: Number(metrics.avgAmount.toFixed(2)) },
  ]), [metrics]);

  const activitySnapshot = useMemo(() => ([
    { label: "Transactions", value: metrics.transactionCount },
    { label: "Students", value: metrics.uniqueStudents },
  ]), [metrics]);

  const dailyCollections = useMemo(() => buildDailyCollections(financeRows, 7), [financeRows]);
  const monthlyCollections = useMemo(() => buildMonthlyCollections(financeRows, 6), [financeRows]);
  const accessibleModules = useMemo(() => getEffectiveDashboardModules(user, "finance"), [user]);
  const overviewModule = useMemo(() => getDashboardModule(accessibleModules, "overview"), [accessibleModules]);
  const financeManagementModule = useMemo(() => getDashboardModule(accessibleModules, "finance_management"), [accessibleModules]);
  const extraModules = useMemo(() => getExtraDashboardModules(accessibleModules, DEFAULT_VIEWS), [accessibleModules]);
  const grantedModule = useMemo(() => getDashboardModule(extraModules, activeView), [activeView, extraModules]);
  const breadcrumbSegments = useMemo(() => {
    if (activeView === "overview") return [];

    const segments = [];
    if (overviewModule) {
      segments.push({
        label: overviewModule.label || "Overview",
        onClick: () => setActiveView("overview"),
      });
    }
    if (activeView === "finance_management" && financeManagementModule) {
      segments.push({ label: financeManagementModule.label || "Finance Management", current: true });
      return segments;
    }
    if (grantedModule?.label) {
      segments.push({ label: grantedModule.label, current: true });
    }
    return segments;
  }, [activeView, overviewModule, financeManagementModule, grantedModule?.label]);

  useEffect(() => {
    const nextView = resolveAccessibleDashboardView(activeView, accessibleModules, DEFAULT_VIEWS);
    if (nextView && nextView !== activeView) {
      setActiveView(nextView);
    }
  }, [activeView, accessibleModules]);

  if (!user) return null;


  const sidebar = (
    <Sidebar>
      <SidebarList>
        <GrantedModuleSidebarSections
          modules={accessibleModules}
          activeView={activeView}
          onSelect={setActiveView}
          labels={{ overview: "Dashboard" }}
        />
      </SidebarList>
    </Sidebar>
  );

  return (
    <DashboardShell
      title="COC Finance Dashboard"
      user={user}
      sidebar={sidebar}
      onUserUpdate={setUser}
      breadcrumbSegments={breadcrumbSegments}
    >
      {activeView === "overview" && overviewModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          <OverviewHeader
            roleLabel="Finance"
            user={user}
            scope={[{ label: "Campus", value: user?.campus_name }]}
          />

          {dashboardError ? (
            <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", border: "1px solid var(--danger-200)", borderRadius: 8, padding: "8px 9px", marginBottom: 11 }}>
              {dashboardError}
            </div>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(272px, 100%), 1fr))", gap: 12 }}>
            <FinanceLineChart
              title="Collection Snapshot"
              subtitle="Quick amount comparison for the current finance overview"
              data={collectionSnapshot}
              emptyLabel={dashboardLoading ? "Loading chart..." : "No finance records yet."}
              formatValue={(value) => formatCurrency(value)}
            />
            <FinanceLineChart
              title="Activity Snapshot"
              subtitle="Volume of finance activity recorded in the system"
              data={activitySnapshot}
              emptyLabel={dashboardLoading ? "Loading chart..." : "No finance activity yet."}
              formatValue={(value) => Number(value || 0).toLocaleString()}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(272px, 100%), 1fr))", gap: 12, marginTop: 12 }}>
            <FinanceLineChart
              title="Daily Collections"
              subtitle="Amount recorded per day (last 7 days)"
              data={dailyCollections}
              emptyLabel={dashboardLoading ? "Loading chart..." : "No finance records yet."}
              formatValue={(value) => formatCurrency(value)}
            />
            <FinanceLineChart
              title="Monthly Collections"
              subtitle="Amount recorded per month (last 6 months)"
              data={monthlyCollections}
              emptyLabel={dashboardLoading ? "Loading chart..." : "No finance records yet."}
              formatValue={(value) => formatCurrency(value)}
            />
          </div>
        </section>
      ) : null}

      {activeView === "finance_management" && financeManagementModule ? (
        <FinanceManage user={user} permissions={financeManagementModule.permissions} />
      ) : null}
      {grantedModule ? <GrantedModuleView module={grantedModule} user={user} modules={accessibleModules} /> : null}
    </DashboardShell>
  );
}
