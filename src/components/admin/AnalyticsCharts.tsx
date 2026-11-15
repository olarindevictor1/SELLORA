import React, { useState } from 'react';
import { formatNgn } from '../../shared/types';

export interface DonutDatum {
  key: string;
  label: string;
  value: number;
  color: string;
  sublabel?: string;
}

interface InteractiveDonutChartProps {
  title: string;
  subtitle?: string;
  data: DonutDatum[];
  centerLabel: string;
  emptyTitle?: string;
  emptyDescription?: string;
  valueFormatter?: (v: number) => string;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeDonutArc(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number
) {
  const span = Math.min(endAngle - startAngle, 359.99);
  const adjustedEnd = startAngle + span;
  const largeArc = span > 180 ? 1 : 0;
  const p1 = polarToCartesian(cx, cy, rOuter, startAngle);
  const p2 = polarToCartesian(cx, cy, rOuter, adjustedEnd);
  const p3 = polarToCartesian(cx, cy, rInner, adjustedEnd);
  const p4 = polarToCartesian(cx, cy, rInner, startAngle);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

export const InteractiveDonutChart: React.FC<InteractiveDonutChartProps> = ({
  title,
  subtitle,
  data,
  centerLabel,
  emptyTitle = 'No recorded data yet',
  emptyDescription = 'Real records appear here once activity occurs in the selected date range.',
  valueFormatter = (v) => v.toLocaleString(),
}) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const nonZero = data.filter((d) => d.value > 0);
  const total = nonZero.reduce((sum, d) => sum + d.value, 0);
  const activeItem =
    (hoveredKey && data.find((d) => d.key === hoveredKey && d.value > 0)) || null;

  let currentAngle = 0;
  const slices = nonZero.map((d) => {
    const share = total > 0 ? d.value / total : 0;
    const sweep = share * 360;
    const path = describeDonutArc(90, 90, 74, 48, currentAngle, currentAngle + sweep);
    currentAngle += sweep;
    return {
      ...d,
      path,
      pct: total > 0 ? Number(((d.value / total) * 100).toFixed(1)) : 0,
    };
  });

  return (
    <section className="rounded-xl bg-white border border-slate-200 p-5 flex flex-col justify-between gap-4">
      <div>
        <h3 className="text-sm font-bold text-[#172554]">{title}</h3>
        {subtitle && <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>}
      </div>

      {total === 0 ? (
        <div className="flex flex-col sm:flex-row items-center gap-4 py-4">
          <svg viewBox="0 0 180 180" className="w-36 h-36 shrink-0" aria-hidden="true">
            <circle
              cx="90"
              cy="90"
              r="61"
              fill="none"
              stroke="#E2E8F0"
              strokeWidth="24"
              strokeDasharray="6 4"
            />
            <text
              x="90"
              y="88"
              textAnchor="middle"
              className="fill-[#172554] text-lg font-bold"
            >
              0
            </text>
            <text x="90" y="106" textAnchor="middle" className="fill-slate-400 text-[10px]">
              {centerLabel}
            </text>
          </svg>
          <div className="text-xs text-slate-500 space-y-1 text-center sm:text-left">
            <div className="font-semibold text-[#172554]">{emptyTitle}</div>
            <p className="leading-relaxed">{emptyDescription}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row items-center gap-5">
          <div className="relative w-40 h-40 shrink-0">
            <svg
              viewBox="0 0 180 180"
              className="w-full h-full"
              role="img"
              aria-label={`${title} distribution`}
            >
              {slices.map((slice) => {
                const isActive = activeItem?.key === slice.key;
                const dimmed = Boolean(activeItem && !isActive);
                return (
                  <path
                    key={slice.key}
                    d={slice.path}
                    fill={slice.color}
                    opacity={dimmed ? 0.4 : 1}
                    stroke="#FFFFFF"
                    strokeWidth={1.5}
                    className="cursor-pointer transition-opacity duration-150 focus:outline-none"
                    tabIndex={0}
                    role="button"
                    aria-label={`${slice.label}: ${valueFormatter(slice.value)} (${slice.pct}%)`}
                    onMouseEnter={() => setHoveredKey(slice.key)}
                    onMouseLeave={() => setHoveredKey(null)}
                    onFocus={() => setHoveredKey(slice.key)}
                    onBlur={() => setHoveredKey(null)}
                    onClick={() =>
                      setHoveredKey((prev) => (prev === slice.key ? null : slice.key))
                    }
                  />
                );
              })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
              <span className="text-[10px] font-medium text-slate-500 truncate max-w-full">
                {activeItem ? activeItem.label : centerLabel}
              </span>
              <span className="text-base font-bold text-[#172554] tabular-nums">
                {valueFormatter(activeItem ? activeItem.value : total)}
              </span>
              {activeItem && (
                <span className="text-[10px] font-semibold text-slate-600 tabular-nums">
                  {total > 0 ? ((activeItem.value / total) * 100).toFixed(1) : '0.0'}%
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 w-full space-y-1.5 text-xs max-h-52 overflow-y-auto pr-1">
            {data.map((item) => {
              const pct = total > 0 ? ((item.value / total) * 100).toFixed(1) : '0.0';
              const isActive = activeItem?.key === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onMouseEnter={() => item.value > 0 && setHoveredKey(item.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                  onClick={() =>
                    item.value > 0 &&
                    setHoveredKey((prev) => (prev === item.key ? null : item.key))
                  }
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                    isActive ? 'bg-[#F5F7F4] ring-1 ring-slate-300' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-xs shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-[#1E293B] truncate">{item.label}</span>
                  </span>
                  <span className="flex items-center gap-2 shrink-0 tabular-nums">
                    <strong className="text-[#172554]">{valueFormatter(item.value)}</strong>
                    <span className="text-[11px] text-slate-500 w-11 text-right">{pct}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};

export interface TrendPoint {
  period: string;
  orders: number;
  total_kobo: number;
}

interface SalesTrendLineChartProps {
  daily: TrendPoint[];
  weekly: TrendPoint[];
  monthly: TrendPoint[];
}

function formatCompactNaira(kobo: number): string {
  const naira = kobo / 100;
  if (naira >= 1_000_000) return `₦${(naira / 1_000_000).toFixed(1)}M`;
  if (naira >= 1_000) return `₦${(naira / 1_000).toFixed(0)}k`;
  return `₦${naira.toFixed(0)}`;
}

export const SalesTrendLineChart: React.FC<SalesTrendLineChartProps> = ({
  daily,
  weekly,
  monthly,
}) => {
  const [granularity, setGranularity] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const series =
    granularity === 'daily' ? daily : granularity === 'weekly' ? weekly : monthly;

  const width = 640;
  const height = 220;
  const padLeft = 62;
  const padRight = 20;
  const padTop = 18;
  const padBottom = 34;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxVal = Math.max(0, ...series.map((p) => p.total_kobo));
  const yMax = maxVal > 0 ? maxVal : 100_00;

  const points = series.map((p, idx) => {
    const x =
      series.length === 1
        ? padLeft + chartW / 2
        : padLeft + (idx / (series.length - 1)) * chartW;
    const y = padTop + chartH - (p.total_kobo / yMax) * chartH;
    return { ...p, x, y, idx };
  });

  const linePath = points
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(' ');
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + chartH).toFixed(
          1
        )} L ${points[0].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`
      : '';

  const activePoint =
    activeIndex !== null && points[activeIndex] ? points[activeIndex] : points[points.length - 1] || null;

  const totalRangeKobo = series.reduce((sum, s) => sum + s.total_kobo, 0);
  const totalRangeOrders = series.reduce((sum, s) => sum + s.orders, 0);

  return (
    <section className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#172554]">Confirmed Sales Trend</h3>
          <p className="text-[11px] text-slate-500">
            Tracks verified <code className="font-mono">payment_confirmed</code> orders only.
            Unverified bank transfers are excluded.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#F5F7F4] border border-slate-200 rounded-lg">
          {(
            [
              { id: 'daily', label: 'Daily' },
              { id: 'weekly', label: 'Weekly' },
              { id: 'monthly', label: 'Monthly' },
            ] as const
          ).map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                setGranularity(g.id);
                setActiveIndex(null);
              }}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                granularity === g.id
                  ? 'bg-[#172554] text-[#B7F36B]'
                  : 'text-slate-600 hover:text-[#172554]'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {series.length === 0 ? (
        <div className="rounded-lg bg-[#F5F7F4] border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500">
          No confirmed payment sales recorded in the selected date range.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs bg-[#F5F7F4] border border-slate-200 rounded-lg px-3.5 py-2">
            <div>
              <span className="text-slate-500">Selected Period: </span>
              <strong className="text-[#172554] font-mono tabular-nums">
                {activePoint?.period}
              </strong>
              <span className="text-slate-400 mx-2">·</span>
              <strong className="text-[#172554] tabular-nums">
                {formatNgn(activePoint?.total_kobo || 0)}
              </strong>
              <span className="text-slate-600 ml-1.5 tabular-nums">
                ({activePoint?.orders || 0} confirmed{' '}
                {(activePoint?.orders || 0) === 1 ? 'order' : 'orders'})
              </span>
            </div>
            <div className="text-slate-600 tabular-nums">
              Range Total: <strong className="text-[#172554]">{formatNgn(totalRangeKobo)}</strong> ({totalRangeOrders})
            </div>
          </div>

          <div className="w-full overflow-x-auto">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full min-w-[320px] h-auto"
              role="img"
              aria-label={`Confirmed ${granularity} sales trend chart`}
            >
              {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
                const y = padTop + chartH - tick * chartH;
                const val = Math.round(tick * yMax);
                return (
                  <g key={tick}>
                    <line
                      x1={padLeft}
                      y1={y}
                      x2={width - padRight}
                      y2={y}
                      stroke="#E2E8F0"
                      strokeDasharray={tick === 0 ? undefined : '3 3'}
                    />
                    <text
                      x={padLeft - 8}
                      y={y + 3}
                      textAnchor="end"
                      className="fill-slate-500 text-[10px] font-mono"
                    >
                      {formatCompactNaira(val)}
                    </text>
                  </g>
                );
              })}

              {points.length > 1 && (
                <path d={areaPath} fill="#172554" fillOpacity="0.08" />
              )}
              {points.length > 1 && (
                <path
                  d={linePath}
                  fill="none"
                  stroke="#172554"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {points.map((pt) => {
                const isActive = activePoint?.idx === pt.idx;
                const showLabel =
                  points.length <= 7 ||
                  pt.idx === 0 ||
                  pt.idx === points.length - 1 ||
                  pt.idx % Math.ceil(points.length / 6) === 0;
                return (
                  <g key={pt.period}>
                    {showLabel && (
                      <text
                        x={pt.x}
                        y={height - 10}
                        textAnchor="middle"
                        className="fill-slate-500 text-[10px] font-mono"
                      >
                        {pt.period}
                      </text>
                    )}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={isActive ? 6 : 4}
                      fill={isActive ? '#B7F36B' : '#172554'}
                      stroke="#172554"
                      strokeWidth={isActive ? 2 : 1.5}
                      className="cursor-pointer"
                      tabIndex={0}
                      role="button"
                      aria-label={`${pt.period}: ${formatNgn(pt.total_kobo)}, ${pt.orders} orders`}
                      onMouseEnter={() => setActiveIndex(pt.idx)}
                      onFocus={() => setActiveIndex(pt.idx)}
                      onClick={() => setActiveIndex(pt.idx)}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      )}
    </section>
  );
};

interface ProductPerfRow {
  product_id: string;
  product_name: string;
  units_sold: number;
  revenue_kobo: number;
}

export const ProductPerformanceBarChart: React.FC<{ items: ProductPerfRow[] }> = ({
  items,
}) => {
  const [metric, setMetric] = useState<'revenue' | 'units'>('revenue');

  const maxRevenue = Math.max(1, ...items.map((i) => Number(i.revenue_kobo || 0)));
  const maxUnits = Math.max(1, ...items.map((i) => Number(i.units_sold || 0)));

  return (
    <section className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#172554]">Best-Selling Product Performance</h3>
          <p className="text-[11px] text-slate-500">
            Actual units sold and revenue from confirmed orders in range.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#F5F7F4] border border-slate-200 rounded-lg">
          <button
            type="button"
            onClick={() => setMetric('revenue')}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              metric === 'revenue'
                ? 'bg-[#172554] text-[#B7F36B]'
                : 'text-slate-600 hover:text-[#172554]'
            }`}
          >
            Revenue (NGN)
          </button>
          <button
            type="button"
            onClick={() => setMetric('units')}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              metric === 'units'
                ? 'bg-[#172554] text-[#B7F36B]'
                : 'text-slate-600 hover:text-[#172554]'
            }`}
          >
            Units Sold
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg bg-[#F5F7F4] border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500">
          No confirmed product sales recorded in the selected date range.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const units = Number(item.units_sold || 0);
            const rev = Number(item.revenue_kobo || 0);
            const widthPct =
              metric === 'revenue'
                ? Math.max(4, Math.round((rev / maxRevenue) * 100))
                : Math.max(4, Math.round((units / maxUnits) * 100));

            return (
              <div key={item.product_id} className="space-y-1 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-[#1E293B] truncate">
                    {item.product_name}
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-600">
                    <strong className="text-[#172554]">{formatNgn(rev)}</strong>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <span>
                      {units} {units === 1 ? 'unit' : 'units'}
                    </span>
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-[#F5F7F4] overflow-hidden border border-slate-200/70">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: metric === 'revenue' ? '#172554' : '#16A34A',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
