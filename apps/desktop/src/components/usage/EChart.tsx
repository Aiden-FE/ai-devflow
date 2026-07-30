// 可复用的 ECharts 生命周期组件：modular 导入、init/setOption/resize/dispose
// 全部托管，初始化与更新错误通过 onError 上报，绝不把异常抛给 React。
import React, { useEffect, useRef } from 'react';
import { init, use, type EChartsType, type SetOptionOpts } from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme';

// 注册本应用所需的最小图表与组件集合；后续如需更多按需追加。
// 在模块多次评估（测试隔离）时也只注册一次。
let featuresRegistered = false;
function ensureFeaturesRegistered(): void {
  if (featuresRegistered) return;
  use([
    LineChart,
    BarChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    AriaComponent,
    CanvasRenderer,
  ]);
  featuresRegistered = true;
}
ensureFeaturesRegistered();

const SET_OPTION_OPTS: SetOptionOpts = {
  notMerge: false,
  replaceMerge: ['series', 'xAxis', 'yAxis'],
};

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

export interface EChartProps {
  /** ECharts option object; updated on every change via setOption. */
  option: Record<string, unknown>;
  /** Accessible label for the chart container (role="img"). */
  ariaLabel: string;
  /** Extra className merged onto the responsive surface. */
  className?: string;
  /** Called when init or setOption throws; the component never throws through React. */
  onError?: (error: unknown) => void;
}

/**
 * Renders a single ECharts canvas inside a fixed responsive surface.
 * Initializes the chart once after mount, applies `setOption` on option or
 * resolved-theme changes, observes the container for resize, and disposes the
 * instance + disconnects the observer on unmount. Both initialization and
 * update failures are reported via `onError` and leave the container stable.
 */
export function EChart({ option, ariaLabel, className, onError }: EChartProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const { resolved } = useTheme();

  // 保持最新的 onError 引用，但不让回调身份变化触发 init/setOption 副作用。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // 创建/销毁实例与 ResizeObserver（仅一次）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let chart: EChartsType;
    try {
      chart = init(el);
      chartRef.current = chart;
    } catch (error) {
      onErrorRef.current?.(error);
      return;
    }

    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // 选项或主题变化时刷新 setOption（不重复 init）。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const effectiveOption = prefersReducedMotion()
      ? { ...option, animationDuration: 0 }
      : option;
    try {
      chart.setOption(effectiveOption, SET_OPTION_OPTS);
    } catch (error) {
      onErrorRef.current?.(error);
    }
  }, [option, resolved]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      className={cn('h-[240px] min-h-[200px] w-full', className)}
    />
  );
}
