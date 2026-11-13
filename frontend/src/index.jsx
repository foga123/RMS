import React from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Outlet,
  RouterProvider,
} from "react-router-dom";
import App from "./app";
import ChangePassword from "./features/auth/ChangePasswordPage";
import RoleDashboardRouter from "./pages/dashboards/RoleDashboardRouter";
import NotFoundPage from "./pages/NotFoundPage";
import { installFetchAuth } from "./shared/lib/authToken";
import { installCrossTabLogout } from "./shared/lib/auth";
import "./global.css";

// Same-origin credentials (Fix #10) plus the bearer token and its
// refresh-and-retry, all in one wrapper — see shared/lib/authToken.js. Called
// before the router mounts so no request can escape it.
installFetchAuth();

// Signing out in one tab signs out the rest. The server already rejects their
// tokens by then; this is what stops a second tab from sitting on a dead
// session until the next click tells it.
installCrossTabLogout();

/*
 * Every route hangs off one pathless parent, purely so they can share an
 * errorElement. Listed flat, an error has no parent route to bubble to and
 * react-router falls back to its own DefaultErrorComponent — the unstyled
 * "Unexpected Application Error!" page that also tells the end user to go add
 * an errorElement. One parent gives all of them a real screen instead.
 *
 * The trailing "*" is a separate job from errorElement: it catches a URL that
 * matched nothing, which is not an error and should not be rendered as one.
 * Listing it means the router never throws a 404 at all.
 */
const router = createBrowserRouter(
  [
    {
      element: <Outlet />,
      errorElement: <NotFoundPage />,
      children: [
        { path: "/", element: <App /> },
        { path: "/change-password", element: <ChangePassword /> },
        { path: "/dashboard", element: <RoleDashboardRouter /> },
        { path: "/dashboard/:roleSlug", element: <RoleDashboardRouter /> },
        { path: "/admin", element: <RoleDashboardRouter roleSlug="admin" /> },
        { path: "/ssg", element: <RoleDashboardRouter roleSlug="ssg" /> },
        { path: "/student", element: <RoleDashboardRouter roleSlug="student" /> },
        { path: "/finance", element: <RoleDashboardRouter roleSlug="finance" /> },
        { path: "/dean", element: <RoleDashboardRouter roleSlug="dean" /> },
        { path: "/program-head", element: <RoleDashboardRouter roleSlug="program-head" /> },
        { path: "/faculty", element: <RoleDashboardRouter roleSlug="faculty" /> },
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ],
  {
    // Every route above is written from the site root, which is only where the
    // app lives under `npm start` and in the container. Served by XAMPP the app
    // sits at /capstone2.0/frontend/build/, so without a basename the router
    // compares that prefix against its routes, matches none of them, and
    // renders nothing — a blank page on a request that returned 200.
    //
    // PUBLIC_URL is set by Create React App from the homepage field, and the
    // container overrides it to "/" at build time, so this follows wherever the
    // build is actually mounted instead of naming one path here.
    basename: process.env.PUBLIC_URL || "/",
  }
);

const root = createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
