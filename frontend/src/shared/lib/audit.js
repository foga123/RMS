const AUDIT_LOG_KEY = "audit_logs";
const MAX_LOGS = 500;

function readRawLogs() {
  try {
    const raw = localStorage.getItem(AUDIT_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLogs(logs) {
  localStorage.setItem(AUDIT_LOG_KEY, JSON.stringify(logs));
}

export function logAuditEvent({
  action,
  detail = "",
  user,
  metadata,
} = {}) {
  const logs = readRawLogs();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action: action || "unknown",
    detail: detail || "",
    user_id: user?.user_id ?? null,
    email: user?.email ?? "",
    role_id: user?.role_id ?? null,
    role_name: user?.role_name ?? "",
    metadata: metadata || null,
  };

  logs.unshift(entry);
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS;
  }
  writeLogs(logs);
  return entry;
}

export function readAuditLogs() {
  return readRawLogs();
}

export function clearAuditLogs() {
  writeLogs([]);
}
