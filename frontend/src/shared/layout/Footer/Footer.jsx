import React from "react";

export default function Footer({ text = "COC Dashboard System", className = "" }) {
  return (
    <footer
      className={`portal-theme-panel border-t border-slate-200/80 px-4 py-3 text-center text-xs text-slate-500 sm:px-6 sm:text-sm ${className}`}
    >
      <span className="font-medium tracking-wide">{text}</span> &copy; {new Date().getFullYear()}
    </footer>
  );
}
