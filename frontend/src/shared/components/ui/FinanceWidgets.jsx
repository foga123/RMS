import React from "react";

const cardBaseStyle = {
  background: "var(--surface-base)",
  border: "1px solid var(--border-base)",
  borderRadius: 12,
  padding: "clamp(0.875rem, 1vw, 1rem)",
  boxShadow: "0 1px 4px rgba(15, 23, 42, 0.05)",
  minWidth: 0,
};

export function FinanceLineChart({
  title,
  subtitle,
  data = [],
  emptyLabel = "No chart data available.",
  formatValue = (value) => String(value),
}) {
  const safeData = Array.isArray(data) ? data : [];
  const chartWidth = 360;
  const chartHeight = 220;
  const paddingX = 24;
  const paddingTop = 20;
  const paddingBottom = 42;
  const innerHeight = chartHeight - paddingTop - paddingBottom;
  const usableWidth = chartWidth - paddingX * 2;
  const maxValue = Math.max(0, ...safeData.map((item) => Number(item?.value || 0)));
  const pointStep = safeData.length > 1 ? usableWidth / (safeData.length - 1) : 0;

  const points = safeData.map((item, index) => {
    const numericValue = Number(item?.value || 0);
    const x = paddingX + pointStep * index;
    const y = paddingTop + innerHeight - (maxValue > 0 ? (numericValue / maxValue) * innerHeight : 0);
    return {
      label: item?.label || "-",
      value: numericValue,
      x,
      y,
    };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  const areaPath = points.length > 0
    ? `${linePath} L ${points[points.length - 1].x} ${paddingTop + innerHeight} L ${points[0].x} ${paddingTop + innerHeight} Z`
    : "";

  const guideLines = [0.25, 0.5, 0.75].map((fraction) => paddingTop + innerHeight * fraction);

  return (
    <article
      style={{
        ...cardBaseStyle,
        display: "grid",
        gap: 9,
      }}
    >
      <div>
        <h3 style={{ margin: 0, color: "var(--text-primary)", fontSize: 16 }}>{title}</h3>
        {subtitle ? <p style={{ margin: "3px 0 0", color: "var(--text-muted)", fontSize: 11.5 }}>{subtitle}</p> : null}
      </div>

      {safeData.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{emptyLabel}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <svg
            width="100%"
            height={chartHeight}
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            role="img"
            aria-label={title}
            style={{ display: "block", minWidth: "min(100%, 272px)" }}
          >
            <rect x="0.5" y="0.5" width={chartWidth - 1} height={chartHeight - 1} rx="12" fill="#f8fafc" stroke="#e2e8f0" />
            {guideLines.map((lineY) => (
              <line key={lineY} x1={paddingX} y1={lineY} x2={chartWidth - paddingX} y2={lineY} stroke="#e2e8f0" strokeDasharray="4 4" />
            ))}

            {areaPath ? <path d={areaPath} fill="rgba(16, 185, 129, 0.14)" /> : null}
            {linePath ? <path d={linePath} fill="none" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /> : null}

            {points.map((point) => (
              <g key={point.label}>
                <circle cx={point.x} cy={point.y} r="4.5" fill="#ffffff" stroke="#047857" strokeWidth="2" />
                <text x={point.x} y={Math.max(14, point.y - 10)} textAnchor="middle" fontSize="11" fontWeight="600" fill="#475569">
                  {formatValue(point.value)}
                </text>
                <text x={point.x} y={chartHeight - 16} textAnchor="middle" fontSize="12" fill="#334155">
                  {point.label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
    </article>
  );
}
