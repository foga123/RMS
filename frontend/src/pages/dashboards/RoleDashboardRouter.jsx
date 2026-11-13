import React, { Suspense, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { readAuthUser, restoreAuthUser } from "../../shared/lib/auth";
import { getDashboardPathForUser, getRoleSlug, normalizeRoleSlug } from "../../shared/lib/roles";
import { resolveRoleDashboard } from "./roleDashboardRegistry";
import DashboardSkeleton from "./DashboardSkeleton";

export default function RoleDashboardRouter({ roleSlug: roleSlugProp }) {
  const params = useParams();
  const user = readAuthUser();
  const [authResolved, setAuthResolved] = useState(Boolean(user));

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        await restoreAuthUser();
      } catch {
        // No user either way: the redirect below lands on the login page,
        // which restores again and explains a 429 if that is what this was.
      } finally {
        if (active) setAuthResolved(true);
      }
    }

    if (!user) {
      void bootstrap();
      return () => {
        active = false;
      };
    }

    setAuthResolved(true);
    return () => {
      active = false;
    };
  }, [user]);

  // Session restore is a network round-trip. Render the dashboard shell rather
  // than nothing, so login does not flash a blank page before painting.
  if (!authResolved) {
    return <DashboardSkeleton />;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (user?.password_expiration?.force_password_change || user?.password_expiration?.is_expired) {
    return <Navigate to="/change-password" replace />;
  }

  const userSlug = getRoleSlug(user);
  if (!userSlug) {
    return <Navigate to="/" replace />;
  }

  const requestedRaw = roleSlugProp ?? params.roleSlug ?? "";
  const requestedSlug = normalizeRoleSlug(requestedRaw);

  if (!requestedSlug) {
    return <Navigate to={getDashboardPathForUser(user)} replace />;
  }

  if (requestedSlug !== userSlug) {
    return <Navigate to={`/dashboard/${userSlug}`} replace />;
  }

  // Each role's dashboard is its own chunk, so the same skeleton that covered
  // the session round-trip above covers the download too. One placeholder for
  // both waits, rather than a flash between two.
  const Dashboard = resolveRoleDashboard(userSlug);
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard user={user} roleSlug={userSlug} />
    </Suspense>
  );
}
