import { useCallback, useEffect, useMemo, useState } from "react";
import { getBackendUrl } from "../lib/url";

/**
 * Campus / department / course / year-level option lists for the ScopeFilter chain.
 *
 * Reads them from overview_analytics.php rather than from a new endpoint of its
 * own, and that is a deliberate trade. The lists are not static: the courses
 * offered depend on the department chosen, the year levels depend on the
 * course, and a dean must only ever be offered their own department — which is
 * pinned server-side, not by asking politely. All of that logic already exists
 * there and is already the thing the Overview filter obeys.
 *
 * A second endpoint would have to restate the ownership checks, and the moment
 * the two disagree the Reports page starts offering a course the Overview will
 * not scope to. Paying for one extra request buys the guarantee that both
 * screens offer exactly the same choices.
 *
 * The trade is real: this response carries aggregate figures the caller throws
 * away. If that ever shows up in a profile, the fix is a `filters_only=1` flag
 * on the same endpoint — still one source of truth, just a cheaper answer.
 */
export default function useScopeOptions(scope) {
  const { campusId = "", departmentId = "", courseId = "" } = scope || {};

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      // Both are sent because each narrows the next list: without department the
      // course list is every course in the college, and without course the year
      // levels are every year anyone is enrolled in.
      if (campusId) params.set("campus_id", campusId);
      if (departmentId) params.set("department_id", departmentId);
      if (courseId) params.set("course_id", courseId);

      const query = params.toString();
      const res = await fetch(getBackendUrl(`overview_analytics.php${query ? `?${query}` : ""}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.message || "Failed to load filter options");
      setData(payload);
    } catch (loadError) {
      // Non-fatal by design: a report that cannot offer a filter is still a
      // usable report, so this reports the failure and leaves the lists empty
      // rather than blocking the page behind an error state.
      setData(null);
      setError(loadError?.message || "Failed to load filter options");
    } finally {
      setLoading(false);
    }
  }, [campusId, courseId, departmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return useMemo(
    () => ({
      loading,
      error,
      campuses: data?.filters?.campuses || [],
      departments: data?.filters?.departments || [],
      courses: data?.filters?.courses || [],
      yearLevels: data?.filters?.year_levels || [],
      canChooseDepartment: Boolean(data?.scope?.can_choose_department),
      departmentLocked: Boolean(data?.scope?.department_locked),
      departmentName: data?.scope?.department_name || "",
      courseName: data?.scope?.course_name || "",
      departmentLabel: data?.scope?.department_name || "this department",
      reload: load,
    }),
    [data, error, load, loading]
  );
}
