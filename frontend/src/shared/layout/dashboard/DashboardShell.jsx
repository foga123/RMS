import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Swal from "sweetalert2";
import { useLocation, useNavigate } from "react-router-dom";
import RoleLayout from "../RoleLayout";
import useProfileMenu from "../../hooks/useProfileMenu";
import { confirmLogoutTo, getUserInitials, logoutTo, restoreAuthUser, setAuthUser } from "../../lib/auth";
import { logAuditEvent } from "../../lib/audit";
import { getNotifications, markNotificationRead, markAllNotificationsRead, clearReadNotifications } from "../../services/api";
import { ensureSessionStart, getSessionRemainingMs, getSessionTimeoutMinutes, isSessionExpired, recordActivity } from "../../lib/session";
import { buildDashboardIntentSearch, readDashboardIntent } from "../../lib/dashboardIntent";
import { getDashboardPathForUser } from "../../lib/roles";
import { notifyError, notifyInfo, notifySuccess, notifyWarning } from "../../lib/notify";
import { getEffectiveDashboardModules } from "../../../pages/dashboards/moduleAccess";
import ProfileManagementModal from "../../../features/profile/ProfileManagementModal";
import NotificationDetailModal from "../Header/NotificationDetailModal";

const NOTIFICATION_PAGE_SIZE = 8;
const NOTIFICATION_POLL_MS = 30000;
const ACCESS_CHANGE_EVENT_KEYS = new Set([
  "role_permissions_changed_personal",
  "access_updated_personal",
  "access_cleared_personal",
]);

function mergeUniqueNotifications(primaryItems = [], secondaryItems = []) {
  const seenIds = new Set();
  const merged = [];

  [...primaryItems, ...secondaryItems].forEach((item) => {
    const notificationId = Number(item?.notification_id);
    const cacheKey = notificationId > 0 ? `notification:${notificationId}` : JSON.stringify(item || {});
    if (seenIds.has(cacheKey)) return;
    seenIds.add(cacheKey);
    merged.push(item);
  });

  return merged;
}

function showNotificationToast(notification) {
  const title = String(notification?.title || "Notification").trim() || "Notification";
  const text = String(notification?.message || "").trim();
  const options = {
    toast: true,
    position: "top-end",
    timer: 3600,
    timerProgressBar: true,
    showConfirmButton: false,
  };

  if (notification?.level === "success") {
    void notifySuccess(title, text, options);
    return;
  }
  if (notification?.level === "warning") {
    void notifyWarning(title, text, options);
    return;
  }
  if (notification?.level === "error") {
    void notifyError(title, text, options);
    return;
  }

  void notifyInfo(title, text, options);
}

function normalizeNotificationTarget(target = {}, includeFallback = true) {
  const normalized = {
    view: String(target?.view || "").trim().toLowerCase(),
    report: String(target?.report || "").trim().toLowerCase(),
    section: String(target?.section || "").trim(),
    overlay: String(target?.overlay || "").trim().toLowerCase(),
    label: String(target?.label || "").trim(),
    actionLabel: String(target?.action_label || "").trim() || "View",
    fallback: null,
  };

  if (includeFallback && target?.fallback && typeof target.fallback === "object") {
    normalized.fallback = normalizeNotificationTarget(target.fallback, false);
  }

  return normalized;
}

function notificationTargetHasDestination(target) {
  return Boolean(target?.view || target?.report || target?.section || target?.overlay);
}

function resolveNotificationTarget(notification, accessibleViews = new Set()) {
  const primaryTarget = normalizeNotificationTarget(notification?.target || {});
  const candidates = [primaryTarget, primaryTarget.fallback]
    .filter((target) => notificationTargetHasDestination(target));

  if (candidates.length === 0) {
    return null;
  }

  const accessibleTarget = candidates.find((target) => (
    target.overlay === "profile"
    || target.overlay === "change_password"
    || !target.view
    || accessibleViews.size === 0
    || accessibleViews.has(target.view)
  ));

  // No accessible destination means no button, rather than a button to a module
  // this account does not have. Falling back to candidates[0] offered a student
  // "Go to Responses/Submissions" — staff-only — and clicking it went nowhere.
  // A dead end is worse than no offer.
  return accessibleTarget || null;
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeComparableValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((normalized, key) => ({
        ...normalized,
        [key]: normalizeComparableValue(value[key]),
      }), {});
  }
  return value ?? null;
}

function isSamePasswordExpiration(currentExpiration, nextExpiration) {
  return JSON.stringify(normalizeComparableValue(currentExpiration))
    === JSON.stringify(normalizeComparableValue(nextExpiration));
}

export default function DashboardShell({
  layout = "role",
  title,
  user,
  initials: initialsProp,
  sidebar,
  notificationCount = 0,
  onNotifications,
  onProfile,
  // Passed straight to the header's account menu. A dashboard supplies it only
  // when the signed-in user actually has the settings module.
  onSettings = null,
  settingsLabel,
  onUserUpdate,
  onLogout,
  breadcrumbSegments,
  children,
  ...rest
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { menuOpen, setMenuOpen, menuRef } = useProfileMenu();
  const [profileOpen, setProfileOpen] = useState(false);
  const [activeUser, setActiveUser] = useState(user || null);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsLoadingMore, setNotificationsLoadingMore] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [notificationsUnreadCount, setNotificationsUnreadCount] = useState(Number.isFinite(notificationCount) ? notificationCount : 0);
  const [notificationPage, setNotificationPage] = useState(1);
  const [notificationsHasMore, setNotificationsHasMore] = useState(false);
  const [notificationsMarkingAll, setNotificationsMarkingAll] = useState(false);
  const [notificationsClearingRead, setNotificationsClearingRead] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState(null);
  const initials = initialsProp ?? getUserInitials(activeUser || user);

  const warningShownRef = useRef(false);
  const warningOpenRef = useRef(false);
  const warningTimerRef = useRef(null);
  const notificationBootstrappedRef = useRef(false);
  const seenNotificationIdsRef = useRef(new Set());
  const seenAccessChangeNotificationIdsRef = useRef(new Set());
  const notificationRefreshInFlightRef = useRef(false);
  const notificationCountRef = useRef(Number.isFinite(notificationCount) ? notificationCount : 0);
  const latestUserRef = useRef(user || null);
  const onUserUpdateRef = useRef(onUserUpdate);

  useEffect(() => {
    onUserUpdateRef.current = onUserUpdate;
  }, [onUserUpdate]);

  useEffect(() => {
    notificationCountRef.current = Number.isFinite(notificationCount) ? notificationCount : 0;
  }, [notificationCount]);

  useEffect(() => {
    const nextUser = user || null;
    latestUserRef.current = nextUser;
    setActiveUser(nextUser);
  }, [user]);

  useEffect(() => {
    latestUserRef.current = activeUser || user || null;
  }, [activeUser, user]);

  const handleUserUpdate = useCallback((nextUser) => {
    const resolvedUser = nextUser || null;
    latestUserRef.current = resolvedUser;
    setActiveUser(resolvedUser);
    setAuthUser(resolvedUser);
    if (typeof onUserUpdateRef.current === "function") {
      onUserUpdateRef.current(resolvedUser);
    }
  }, []);

  useEffect(() => {
    const handleAuthUserRefreshed = (event) => {
      const refreshedUser = event?.detail?.user || null;
      if (!refreshedUser) return;
      handleUserUpdate(refreshedUser);
    };

    window.addEventListener("auth-user-refreshed", handleAuthUserRefreshed);
    return () => {
      window.removeEventListener("auth-user-refreshed", handleAuthUserRefreshed);
    };
  }, [handleUserUpdate]);

  const refreshAuthenticatedUser = useCallback(async () => {
    try {
      const refreshedUser = await restoreAuthUser({ force: true });
      handleUserUpdate(refreshedUser || null);
      return refreshedUser || null;
    } catch {
      return null;
    }
  }, [handleUserUpdate]);

  const updatePasswordExpiration = useCallback((passwordExpiration) => {
    if (!passwordExpiration) {
      return;
    }

    const baseUser = latestUserRef.current || null;
    if (!baseUser) {
      return;
    }
    if (isSamePasswordExpiration(baseUser.password_expiration, passwordExpiration)) {
      return;
    }

    const nextUser = {
      ...baseUser,
      password_expiration: passwordExpiration,
    };

    handleUserUpdate(nextUser);
  }, [handleUserUpdate]);

  useEffect(() => {
    if (!selectedNotification) {
      return;
    }

    const selectedId = Number(selectedNotification?.notification_id);
    if (selectedId <= 0) {
      return;
    }

    const nextNotification = notifications.find((item) => Number(item?.notification_id) === selectedId);
    if (!nextNotification) {
      return;
    }

    setSelectedNotification((current) => {
      if (Number(current?.notification_id) !== selectedId) {
        return current;
      }
      const hasSameCoreValues = current?.title === nextNotification?.title
        && current?.message === nextNotification?.message
        && current?.level === nextNotification?.level
        && current?.created_at === nextNotification?.created_at
        && current?.read === nextNotification?.read
        && current?.read_at === nextNotification?.read_at;
      if (hasSameCoreValues) {
        return current;
      }
      return {
        ...current,
        ...nextNotification,
      };
    });
  }, [notifications, selectedNotification]);

  useEffect(() => {
    const intent = readDashboardIntent(location.search);
    if (intent.overlay === "profile" && !onProfile) {
      setProfileOpen(true);
    }
  }, [location.search, onProfile]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setNotificationOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setNotificationOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuRef]);

  useEffect(() => {
    if (!user) return undefined;
    ensureSessionStart();
    recordActivity();

    const clearWarningTimer = () => {
      if (warningTimerRef.current) {
        clearInterval(warningTimerRef.current);
        warningTimerRef.current = null;
      }
    };

    const closeWarning = () => {
      clearWarningTimer();
      if (warningOpenRef.current && Swal.isVisible()) {
        Swal.close();
      }
      warningOpenRef.current = false;
    };

    const formatWarningMessage = (remainingMs) => {
      const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      return `Your session will expire in ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}. Please save your work.`;
    };

    const updateWarningCountdown = () => {
      const container = Swal.getHtmlContainer();
      const remainingMs = getSessionRemainingMs();
      if (!container || remainingMs == null) return;
      // Use safe DOM manipulation instead of innerHTML to prevent XSS (Fix #11)
      const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      container.textContent = "";
      container.appendChild(document.createTextNode("Your session will expire in "));
      const strong = document.createElement("strong");
      strong.textContent = String(remainingSeconds);
      container.appendChild(strong);
      container.appendChild(document.createTextNode(` second${remainingSeconds === 1 ? "" : "s"}. Please save your work.`));
    };

    const openWarning = () => {
      warningOpenRef.current = true;
      clearWarningTimer();
      void Swal.fire({
        icon: "warning",
        title: "Session Expiring",
        html: formatWarningMessage(getSessionRemainingMs() ?? 1000),
        confirmButtonText: "OK",
        confirmButtonColor: "var(--warning-500)",
        didOpen: () => {
          updateWarningCountdown();
          warningTimerRef.current = setInterval(() => {
            const remainingMs = getSessionRemainingMs();
            if (!Swal.isVisible() || remainingMs == null || remainingMs <= 0) {
              closeWarning();
              return;
            }
            updateWarningCountdown();
          }, 1000);
        },
        willClose: () => {
          clearWarningTimer();
          warningOpenRef.current = false;
        },
      });
    };

    let lastActivityWrite = 0;
    const handleActivity = () => {
      warningShownRef.current = false;
      closeWarning();
      const now = Date.now();
      if (now - lastActivityWrite < 5000) return;
      lastActivityWrite = now;
      recordActivity(now);
    };

    const activityEvents = ["mousemove", "keydown", "mousedown", "touchstart", "scroll"];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, handleActivity, { passive: true }));

    const checkSession = () => {
      const remainingMs = getSessionRemainingMs();
      if (remainingMs != null) {
        const timeoutMs = getSessionTimeoutMinutes() * 60 * 1000;
        const warningThresholdMs = Math.min(60 * 1000, Math.max(10 * 1000, timeoutMs * 0.2));
        if (remainingMs > warningThresholdMs) {
          warningShownRef.current = false;
          closeWarning();
        }
        if (!warningShownRef.current && remainingMs > 0 && remainingMs <= warningThresholdMs) {
          warningShownRef.current = true;
          openWarning();
        }
      }

      if (isSessionExpired()) {
        closeWarning();
        logAuditEvent({ action: "session_timeout", user });
        void logoutTo("/");
      }
    };

    checkSession();
    const interval = setInterval(checkSession, 5 * 1000);
    return () => {
      clearInterval(interval);
      closeWarning();
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, handleActivity));
    };
  }, [user]);

  const currentUser = activeUser || user || null;
  const accessibleNotificationViews = useMemo(() => {
    const modules = getEffectiveDashboardModules(currentUser);
    return new Set(
      modules
        .map((module) => String(module?.view || "").trim().toLowerCase())
      .filter(Boolean)
    );
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser?.password_expiration?.force_password_change && !currentUser?.password_expiration?.is_expired) {
      return;
    }
    if (location.pathname === "/change-password") {
      return;
    }
    navigate("/change-password", { replace: true });
  }, [currentUser?.password_expiration?.force_password_change, currentUser?.password_expiration?.is_expired, location.pathname, navigate]);

  const refreshNotifications = useCallback(async ({
    page = 1,
    append = false,
    silent = false,
    showToasts = false,
  } = {}) => {
    if (!currentUser?.user_id) {
      return null;
    }
    if (!append && notificationRefreshInFlightRef.current) {
      return null;
    }

    if (append) {
      if (!silent) setNotificationsLoadingMore(true);
    } else {
      notificationRefreshInFlightRef.current = true;
      if (!silent) setNotificationsLoading(true);
    }
    if (!silent) {
      setNotificationsError("");
    }

    try {
      const payload = await getNotifications({ page, limit: NOTIFICATION_PAGE_SIZE });
      const data = payload?.data || {};
      const nextItems = Array.isArray(data?.items) ? data.items : [];
      const nextUnreadCount = Number.isFinite(data?.unread_count) ? data.unread_count : 0;
      const nextHasMore = Boolean(data?.pagination?.has_more);
      const nextPage = Number(data?.pagination?.page) || page;
      updatePasswordExpiration(data?.password_expiration);

      setNotifications((currentItems) => (
        append
          ? mergeUniqueNotifications(currentItems, nextItems)
          : mergeUniqueNotifications(nextItems, currentItems)
      ));
      setNotificationsUnreadCount(nextUnreadCount);
      setNotificationsHasMore(nextHasMore);
      setNotificationPage(nextPage);
      setNotificationsError("");

      const seenIds = seenNotificationIdsRef.current;
      if (notificationBootstrappedRef.current && showToasts) {
        nextItems.forEach((item) => {
          const notificationId = Number(item?.notification_id);
          if (notificationId <= 0 || seenIds.has(notificationId)) {
            return;
          }
          if (item?.toast && !item?.read) {
            showNotificationToast(item);
          }
        });
      }

      const accessChangeIds = [];
      nextItems.forEach((item) => {
        const notificationId = Number(item?.notification_id);
        const eventKey = String(item?.event_key || "").trim();
        if (
          notificationId > 0 &&
          ACCESS_CHANGE_EVENT_KEYS.has(eventKey) &&
          !seenAccessChangeNotificationIdsRef.current.has(notificationId)
        ) {
          accessChangeIds.push(notificationId);
        }
      });

      if (accessChangeIds.length > 0) {
        accessChangeIds.forEach((notificationId) => {
          seenAccessChangeNotificationIdsRef.current.add(notificationId);
        });
        void refreshAuthenticatedUser();
      }

      nextItems.forEach((item) => {
        const notificationId = Number(item?.notification_id);
        if (notificationId > 0) {
          seenIds.add(notificationId);
        }
      });
      notificationBootstrappedRef.current = true;

      return data;
    } catch (error) {
      if (!silent) {
        setNotificationsError(error?.message || "Failed to load notifications.");
      }
      return null;
    } finally {
      if (append) {
        if (!silent) setNotificationsLoadingMore(false);
      } else {
        notificationRefreshInFlightRef.current = false;
        if (!silent) setNotificationsLoading(false);
      }
    }
  }, [currentUser?.user_id, refreshAuthenticatedUser, updatePasswordExpiration]);

  useEffect(() => {
    setNotificationOpen(false);
    setSelectedNotification(null);
    setNotifications([]);
    setNotificationsError("");
    setNotificationsHasMore(false);
    setNotificationPage(1);
    setNotificationsUnreadCount(notificationCountRef.current);
    notificationBootstrappedRef.current = false;
    seenNotificationIdsRef.current = new Set();
    seenAccessChangeNotificationIdsRef.current = new Set();
    notificationRefreshInFlightRef.current = false;

    if (!currentUser?.user_id) {
      return undefined;
    }

    // Bootstrap stays silent: everything already waiting would toast at once on
    // every page load.
    void refreshNotifications({ page: 1, silent: true, showToasts: false });

    const poll = () => {
      // A hidden tab was still polling every 30s. That is a wasted request per
      // open tab, and now that toasts actually fire it would stack them up out
      // of sight for whenever the tab is next focused.
      if (document.visibilityState === "hidden") return;
      void refreshNotifications({ page: 1, silent: true, showToasts: true });
    };

    const intervalId = window.setInterval(poll, NOTIFICATION_POLL_MS);

    // Catch up on return instead of waiting out the rest of the interval.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentUser?.user_id, refreshNotifications]);

  const clearProfileOverlayIntent = useCallback(() => {
    const nextSearch = buildDashboardIntentSearch(location.search, { overlay: "" });
    if (nextSearch === location.search) {
      return;
    }
    navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const closeProfileModal = useCallback(() => {
    setProfileOpen(false);
    clearProfileOverlayIntent();
  }, [clearProfileOverlayIntent]);

  const closeNotificationModal = useCallback(() => {
    setSelectedNotification(null);
  }, []);

  const handleNotificationMarkRead = useCallback(async (notificationId, { silent = false } = {}) => {
    const resolvedId = Number(notificationId);
    if (resolvedId <= 0) {
      return false;
    }

    try {
      await markNotificationRead(resolvedId);
      let reducedUnread = false;
      setNotifications((currentItems) => currentItems.map((item) => {
        if (Number(item?.notification_id) !== resolvedId) {
          return item;
        }
        if (!item?.read) {
          reducedUnread = true;
        }
        return {
          ...item,
          read: true,
          read_at: item?.read_at || new Date().toISOString(),
        };
      }));
      if (reducedUnread) {
        setNotificationsUnreadCount((count) => Math.max(0, (Number(count) || 0) - 1));
      }
      return true;
    } catch (error) {
      if (!silent) {
        void notifyError("Notification update failed", error?.message || "Failed to update the notification.");
      }
      return false;
    }
  }, []);

  const handleNotificationMarkAllRead = useCallback(async () => {
    if (notificationsUnreadCount <= 0) {
      return;
    }

    setNotificationsMarkingAll(true);
    try {
      await markAllNotificationsRead();
      setNotifications((currentItems) => currentItems.map((item) => ({
        ...item,
        read: true,
        read_at: item?.read_at || new Date().toISOString(),
      })));
      setNotificationsUnreadCount(0);
    } catch (error) {
      void notifyError("Notification update failed", error?.message || "Failed to mark all notifications as read.");
    } finally {
      setNotificationsMarkingAll(false);
    }
  }, [notificationsUnreadCount]);

  const handleNotificationClearRead = useCallback(async () => {
    setNotificationsClearingRead(true);
    try {
      await clearReadNotifications();
      setNotifications((currentItems) => currentItems.filter((item) => !item?.read));
      await refreshNotifications({ page: 1, silent: true, showToasts: false });
    } catch (error) {
      void notifyError("Notification clear failed", error?.message || "Failed to clear read notifications.");
    } finally {
      setNotificationsClearingRead(false);
    }
  }, [refreshNotifications]);

  const handleNotificationLoadMore = useCallback(() => {
    if (notificationsLoadingMore || !notificationsHasMore) {
      return;
    }
    void refreshNotifications({
      page: notificationPage + 1,
      append: true,
      silent: true,
      showToasts: false,
    });
  }, [notificationPage, notificationsHasMore, notificationsLoadingMore, refreshNotifications]);

  const handleProfile = () => {
    setMenuOpen(false);
    setNotificationOpen(false);
    if (onProfile) {
      void onProfile();
    } else {
      setProfileOpen(true);
    }
  };

  const handleNotifications = () => {
    setMenuOpen(false);
    setNotificationOpen((currentValue) => {
      const nextValue = !currentValue;
      if (nextValue && notifications.length === 0 && !notificationsLoading) {
        void refreshNotifications({ page: 1, silent: true, showToasts: false });
      }
      return nextValue;
    });
  };

  const handleSettings = onSettings
    ? () => {
        // Same close-everything sequence as Profile: leaving the menu open over
        // the view it just navigated to is the bug this mirrors away.
        setMenuOpen(false);
        setNotificationOpen(false);
        void onSettings();
      }
    : null;

  const handleLogout = () => {
    setMenuOpen(false);
    setNotificationOpen(false);
    if (onLogout) {
      void onLogout();
    } else {
      void confirmLogoutTo("/");
    }
  };

  const openNotificationRelatedPage = useCallback((notification) => {
    if (!notification) {
      return;
    }

    const resolvedTarget = resolveNotificationTarget(notification, accessibleNotificationViews);
    if (!resolvedTarget) {
      return;
    }

    closeNotificationModal();
    setMenuOpen(false);
    setNotificationOpen(false);

    if (resolvedTarget.overlay === "profile" && onProfile) {
      void onProfile();
      return;
    }

    if (resolvedTarget.overlay === "change_password") {
      navigate("/change-password");
      return;
    }

    if (!currentUser) {
      return;
    }

    const nextPath = getDashboardPathForUser(currentUser);
    const nextSearch = buildDashboardIntentSearch("", {
      view: resolvedTarget.view,
      report: resolvedTarget.report,
      section: resolvedTarget.section,
      overlay: resolvedTarget.overlay,
    });

    if (resolvedTarget.view || resolvedTarget.report || resolvedTarget.section || resolvedTarget.overlay) {
      navigate({ pathname: nextPath, search: nextSearch }, { replace: nextPath === location.pathname && nextSearch === location.search });
      if (resolvedTarget.overlay === "profile" && !onProfile) {
        setProfileOpen(true);
      }
    }
  }, [accessibleNotificationViews, closeNotificationModal, currentUser, location.pathname, location.search, navigate, onProfile, setMenuOpen]);

  const handleNotificationView = useCallback((notification) => {
    if (!notification) {
      return;
    }

    setMenuOpen(false);
    setNotificationOpen(false);
    setSelectedNotification(notification);

    const notificationId = Number(notification?.notification_id);
    if (notificationId > 0 && !notification?.read) {
      void handleNotificationMarkRead(notificationId, { silent: true }).then((marked) => {
        if (!marked) {
          return;
        }
        setSelectedNotification((current) => {
          if (Number(current?.notification_id) !== notificationId) {
            return current;
          }
          return {
            ...current,
            read: true,
            read_at: current?.read_at || new Date().toISOString(),
          };
        });
      });
    }
  }, [handleNotificationMarkRead, setMenuOpen]);

  const selectedNotificationTarget = useMemo(
    () => resolveNotificationTarget(selectedNotification, accessibleNotificationViews),
    [accessibleNotificationViews, selectedNotification]
  );

  const resolvedNotificationCount = Number.isFinite(notificationsUnreadCount)
    ? notificationsUnreadCount
    : notificationCount;

  return (
    <>
      <RoleLayout
        layout={layout}
        title={title}
        user={activeUser}
        initials={initials}
        menuRef={menuRef}
        menuOpen={menuOpen}
        onToggleMenu={() => {
          setNotificationOpen(false);
          setMenuOpen((value) => !value);
        }}
        notificationCount={resolvedNotificationCount}
        onNotifications={handleNotifications}
        notificationOpen={notificationOpen}
        notifications={notifications}
        notificationsLoading={notificationsLoading}
        notificationsError={notificationsError}
        notificationsUnreadCount={resolvedNotificationCount}
        notificationsHasMore={notificationsHasMore}
        notificationsLoadingMore={notificationsLoadingMore}
        notificationsMarkingAll={notificationsMarkingAll}
        notificationsClearingRead={notificationsClearingRead}
        onNotificationView={handleNotificationView}
        onNotificationMarkRead={(notificationId) => {
          void handleNotificationMarkRead(notificationId);
        }}
        onNotificationMarkAllRead={() => {
          void handleNotificationMarkAllRead();
        }}
        onNotificationClearRead={() => {
          void handleNotificationClearRead();
        }}
        onNotificationLoadMore={handleNotificationLoadMore}
        onProfile={handleProfile}
        onSettings={handleSettings}
        settingsLabel={settingsLabel}
        onLogout={handleLogout}
        sidebar={sidebar}
        breadcrumbSegments={breadcrumbSegments}
        {...rest}
      >
        {children}
      </RoleLayout>

      {!onProfile && profileOpen ? (
        <ProfileManagementModal
          open={profileOpen}
          user={activeUser}
          onClose={closeProfileModal}
          onUserUpdate={handleUserUpdate}
        />
      ) : null}

      <NotificationDetailModal
        open={Boolean(selectedNotification)}
        notification={selectedNotification}
        canOpenRelatedPage={Boolean(selectedNotificationTarget)}
        relatedPageLabel={selectedNotificationTarget?.label || selectedNotification?.target?.label || ""}
        onClose={closeNotificationModal}
        onOpenRelatedPage={openNotificationRelatedPage}
      />
    </>
  );
}
