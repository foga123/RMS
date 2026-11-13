import React from 'react';
import { useLocation, Link } from 'react-router-dom';
import Icon from './Icon';

const LABEL_OVERRIDES = {
  ssg: "SSG",
  ssp: "SSP",
};

function formatSegmentLabel(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";

  const compact = normalized.replace(/[-_]+/g, " ");
  return compact.replace(/\b\w+\b/g, (word) => LABEL_OVERRIDES[word.toLowerCase()] || `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
}

function normalizeBreadcrumbItem(segment, index, totalItems) {
  if (segment == null) return null;

  if (typeof segment === "string" || typeof segment === "number") {
    const label = formatSegmentLabel(segment);
    if (!label) return null;
    return {
      key: `${label}-${index}`,
      label,
      current: index === totalItems - 1,
    };
  }

  if (typeof segment === "object") {
    const label = formatSegmentLabel(segment.label ?? segment.name ?? segment.title ?? "");
    if (!label) return null;
    return {
      ...segment,
      key: segment.key ?? `${label}-${index}`,
      label,
      current: typeof segment.current === "boolean" ? segment.current : index === totalItems - 1,
    };
  }

  return null;
}

export default function Breadcrumb({ className = "", trailingPath }) {
  const location = useLocation();
  const urlPathnames = location.pathname.split('/').filter((x) => x);
  const hasCustomPath = Array.isArray(trailingPath);
  const rawSegments = hasCustomPath ? trailingPath : urlPathnames;
  const items = rawSegments
    .map((segment, index) => normalizeBreadcrumbItem(segment, index, rawSegments.length))
    .filter(Boolean);

  if (items.length === 0) return null;

  const interactiveClasses = "inline-flex items-center rounded-full border border-transparent px-3 py-1.5 font-medium text-slate-600 transition-all duration-200 hover:border-primary-100 hover:bg-white hover:text-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500/20";
  const currentClasses = "inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-900 shadow-sm";
  const staticClasses = "inline-flex items-center rounded-full px-3 py-1.5 font-medium text-slate-500";

  return (
    <nav aria-label="breadcrumb" className={`z-10 mb-6 ${className}`}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const isCurrent = item.current ?? isLast;
          const routeTo = !hasCustomPath ? `/${urlPathnames.slice(0, index + 1).join('/')}` : item.to;

          let content = (
            <span className={isCurrent ? currentClasses : staticClasses} aria-current={isCurrent ? "page" : undefined}>
              {item.label}
            </span>
          );

          if (!isCurrent && routeTo) {
            content = (
              <Link to={routeTo} onClick={item.onClick} className={interactiveClasses}>
                {item.label}
              </Link>
            );
          } else if (!isCurrent && typeof item.onClick === "function") {
            content = (
              <button type="button" onClick={item.onClick} className={interactiveClasses}>
                {item.label}
              </button>
            );
          }

          return (
            <li key={item.key} className="flex items-center gap-1.5">
              {content}
              {!isLast ? <Icon name="chevronRight" size={12} className="text-slate-400 opacity-60" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
