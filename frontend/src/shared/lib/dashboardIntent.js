function normalizeValue(value) {
  return String(value || "").trim();
}

const DASHBOARD_INTENT_STORAGE_PREFIX = "coc-dashboard-intent:";

function getDashboardIntentStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function getCurrentPathname() {
  try {
    return typeof window !== "undefined" ? window.location.pathname : "";
  } catch {
    return "";
  }
}

function getCurrentSearch() {
  try {
    return typeof window !== "undefined" ? window.location.search : "";
  } catch {
    return "";
  }
}

function getStorageKey(pathname = "") {
  const resolvedPathname = normalizeValue(pathname) || getCurrentPathname() || "/";
  return `${DASHBOARD_INTENT_STORAGE_PREFIX}${resolvedPathname}`;
}

export function readDashboardIntent(search = "") {
  const params = new URLSearchParams(search || "");

  return {
    view: normalizeValue(params.get("view")).toLowerCase(),
    report: normalizeValue(params.get("report")).toLowerCase(),
    section: normalizeValue(params.get("section")),
    overlay: normalizeValue(params.get("overlay")).toLowerCase(),
  };
}

export function buildDashboardIntentSearch(search = "", updates = {}) {
  const params = new URLSearchParams(search || "");

  ["view", "report", "section", "overlay"].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return;
    const value = normalizeValue(updates[key]);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  });

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}

export function readStoredDashboardIntent(pathname = "") {
  const storage = getDashboardIntentStorage();
  if (!storage) return {};

  try {
    const raw = storage.getItem(getStorageKey(pathname));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function persistDashboardIntent(updates = {}, pathname = "") {
  const storage = getDashboardIntentStorage();
  if (!storage || !updates || typeof updates !== "object") return;

  const key = getStorageKey(pathname);
  const next = { ...readStoredDashboardIntent(pathname) };

  ["view", "report", "section"].forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) return;
    const value = normalizeValue(updates[field]);
    if (value) {
      next[field] = field === "section" ? value : value.toLowerCase();
    } else {
      delete next[field];
    }
  });

  try {
    if (Object.keys(next).length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // Ignore storage failures so private mode or disabled storage never breaks navigation.
  }
}

export function getInitialDashboardIntentValue(field, fallback = "", options = {}) {
  const normalizedField = normalizeValue(field);
  if (!normalizedField) return fallback;

  const lowercase = options.lowercase ?? normalizedField !== "section";
  const formatValue = (value) => {
    const normalized = normalizeValue(value);
    return lowercase ? normalized.toLowerCase() : normalized;
  };

  const urlIntent = readDashboardIntent(getCurrentSearch());
  const urlValue = formatValue(urlIntent[normalizedField]);
  if (urlValue) return urlValue;

  const storedIntent = readStoredDashboardIntent(getCurrentPathname());
  const storedValue = formatValue(storedIntent[normalizedField]);
  if (storedValue) return storedValue;

  return fallback;
}
