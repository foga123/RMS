import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { Navigate, useNavigate } from "react-router-dom";
import { Button, Skeleton } from "../../shared/components/ui";
import ChangePasswordForm from "./components/ChangePasswordForm";
import { clearAuthUser, readAuthUser, restoreAuthUser, setAuthUser, logoutTo } from "../../shared/lib/auth";
import { getDashboardPathForUser } from "../../shared/lib/roles";
import { startSession } from "../../shared/lib/session";
import { getAssetUrl } from "../../shared/lib/url";
import { color, font, radius, shadow } from "../../shared/theme/tokens";

export default function ChangePassword() {
  const navigate = useNavigate();
  const [user, setUser] = useState(() => readAuthUser());
  const [authResolved, setAuthResolved] = useState(Boolean(user));
  const expiration = user?.password_expiration || null;
  const mustChangePassword = Boolean(expiration?.force_password_change || expiration?.is_expired);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const restored = await restoreAuthUser({ force: true });
        if (!active) return;
        if (restored) {
          startSession();
          setUser(restored);
        } else {
          clearAuthUser();
          setUser(null);
        }
      } finally {
        if (active) setAuthResolved(true);
      }
    }

    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  // Same reasoning as RoleDashboardRouter: show the card shell while the session
  // is restored instead of a blank page.
  if (!authResolved) {
    return (
      <div
        className="portal-theme-bg flex min-h-dvh items-center justify-center px-4 py-8"
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        <div className="w-full max-w-[408px] rounded-[2rem] border border-slate-200 bg-white p-6 shadow-[0_32px_90px_-36px_rgba(15,23,42,0.45)] sm:p-7">
          <div className="mb-6 flex items-center gap-4">
            <Skeleton width={48} height={48} radius={16} />
            <div style={{ flex: 1 }}>
              <Skeleton width="65%" height={14} />
              <div style={{ height: 7 }} />
              <Skeleton width="45%" height={9} />
            </div>
          </div>
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} style={{ marginBottom: 14 }}>
              <Skeleton width="38%" height={9} />
              <div style={{ height: 7 }} />
              <Skeleton width="100%" height={34} radius={8} />
            </div>
          ))}
          <Skeleton width="100%" height={37} radius={9} />
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const handleSuccess = async (payload) => {
    const nextUser = payload?.user || {
      ...user,
      password_expiration: payload?.password_expiration || user?.password_expiration,
    };
    setAuthUser(nextUser);
    startSession();

    await Swal.fire({
      icon: "success",
      title: "Password changed",
      text: payload?.message || "Your password was updated successfully.",
      confirmButtonColor: color.brand.base,
    });

    navigate(getDashboardPathForUser(nextUser) || "/dashboard", { replace: true });
  };

  return (
    <div className="portal-theme-bg flex min-h-dvh items-center justify-center px-4 py-8">
      <div
        className="w-full max-w-[408px] rounded-[2rem] border border-slate-200 bg-white p-6 sm:p-7"
        style={{ boxShadow: shadow.modal }}
      >
        <div className="mb-6 flex items-center gap-4">
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center"
            style={{
              borderRadius: radius.xl + 4,
              border: `1px solid ${color.border.brand}`,
              background: color.surface.base,
              boxShadow: shadow.panel,
            }}
          >
            <img src={getAssetUrl("assets/coc.png")} alt="PHINMA COC Logo" className="h-10 w-10 object-contain" />
          </div>
          <div className="min-w-0">
            <p
              style={{
                fontSize: font.size.xs,
                fontWeight: font.weight.semibold,
                textTransform: "uppercase",
                letterSpacing: "0.28em",
                color: color.brand.hover,
              }}
            >
              Account Security
            </p>
            <h1 className="mt-1 font-heading text-2xl font-bold tracking-tight" style={{ color: color.text.primary }}>
              Change Password
            </h1>
          </div>
        </div>

        {mustChangePassword ? (
          <div
            style={{
              marginBottom: 16,
              borderRadius: radius.xl,
              border: `1px solid ${color.status.dangerBorder}`,
              background: color.status.dangerBg,
              color: color.status.dangerText,
              padding: "9px 12px",
              fontSize: font.size.md,
              fontWeight: font.weight.medium,
            }}
          >
            {expiration?.remaining_label || "Password Expired"}. Update your password before continuing to the dashboard.
          </div>
        ) : expiration ? (
          <div
            style={{
              marginBottom: 16,
              borderRadius: radius.xl,
              border: `1px solid ${color.border.base}`,
              background: color.surface.subtle,
              color: color.text.secondary,
              padding: "9px 12px",
              fontSize: font.size.md,
              fontWeight: font.weight.medium,
            }}
          >
            {expiration.remaining_label || "Password expiration status unavailable."}
            {expiration.expires_at_display ? ` Expires on ${expiration.expires_at_display}.` : ""}
          </div>
        ) : null}

        <ChangePasswordForm
          onSuccess={handleSuccess}
          footer={
            <Button type="button" variant="secondary" onClick={() => { void logoutTo("/"); }}>
              Logout
            </Button>
          }
        />
      </div>
    </div>
  );
}
