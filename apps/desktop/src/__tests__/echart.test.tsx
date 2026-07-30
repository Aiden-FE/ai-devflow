// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// --- Controllable theme (EChart consumes useTheme().resolved) ---
const themeState = vi.hoisted(() => ({ current: 'light' as 'light' | 'dark' }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ resolved: themeState.current }),
}));

// --- Mock echarts/core: init returns a fake chart; use is a spy ---
const { init, use, chart } = vi.hoisted(() => {
  const fakeChart = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    chart: fakeChart,
    init: vi.fn(() => fakeChart),
    use: vi.fn(),
  };
});
vi.mock('echarts/core', () => ({ init, use }));

// --- Controllable ResizeObserver ---
type ROEntries = Array<{ contentRect: { width: number; height: number } }>;
let roCallback: ((entries: ROEntries) => void) | null = null;
let lastObserver: MockResizeObserver | null = null;
class MockResizeObserver {
  disconnect = vi.fn();
  constructor(cb: (entries: ROEntries) => void) {
    roCallback = cb;
    lastObserver = this;
  }
  observe(): void {}
  unobserve(): void {}
}

const matchMediaMock = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

const { EChart } = await import('../components/usage/EChart.js');

const option = { series: [{ type: 'line', data: [1, 2, 3] }] } as const;

const trackedRoots: ReturnType<typeof createRoot>[] = [];

function setup(props?: { option?: Record<string, unknown>; ariaLabel?: string; onError?: (e: unknown) => void; className?: string }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onError = props?.onError ?? vi.fn();
  const root = createRoot(container);
  trackedRoots.push(root);
  act(() => {
    root.render(
      <EChart
        option={props?.option ?? option}
        ariaLabel={props?.ariaLabel ?? 'test chart'}
        className={props?.className}
        onError={onError}
      />,
    );
  });
  return { container, root, onError };
}

describe('EChart lifecycle', () => {
  beforeEach(() => {
    init.mockClear();
    chart.setOption.mockClear();
    chart.resize.mockClear();
    chart.dispose.mockClear();
    roCallback = null;
    lastObserver?.disconnect.mockClear();
    lastObserver = null;
    trackedRoots.length = 0;
    themeState.current = 'light';
    matchMediaMock.mockClear();
    matchMediaMock.mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    Object.defineProperty(globalThis, 'ResizeObserver', { value: MockResizeObserver, configurable: true, writable: true });
    Object.defineProperty(window, 'matchMedia', { value: matchMediaMock, configurable: true, writable: true });
  });

  afterEach(() => {
    for (const root of trackedRoots) {
      act(() => {
        root.unmount();
      });
    }
    trackedRoots.length = 0;
    vi.restoreAllMocks();
  });

  it('initializes once, sets option with exact merge opts, resizes, and disposes on unmount', () => {
    const { root } = setup();

    expect(use).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(chart.setOption).toHaveBeenCalledWith(option, {
      notMerge: false,
      replaceMerge: ['series', 'xAxis', 'yAxis'],
    });

    // Resize observer drives chart.resize
    expect(roCallback).not.toBeNull();
    act(() => {
      roCallback!([{ contentRect: { width: 120, height: 80 } }]);
    });
    expect(chart.resize).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    expect(chart.dispose).toHaveBeenCalledTimes(1);
    expect(lastObserver?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('updates option without re-initializing', () => {
    const { root } = setup();
    expect(init).toHaveBeenCalledTimes(1);

    const nextOption = { series: [{ type: 'bar', data: [4, 5] }] } as const;
    act(() => {
      root.render(<EChart option={nextOption} ariaLabel="test chart" />);
    });

    expect(init).toHaveBeenCalledTimes(1);
    expect(chart.setOption).toHaveBeenLastCalledWith(nextOption, {
      notMerge: false,
      replaceMerge: ['series', 'xAxis', 'yAxis'],
    });
  });

  it('reacts to theme changes without re-initializing', () => {
    const { root } = setup();
    expect(init).toHaveBeenCalledTimes(1);
    const callsBefore = chart.setOption.mock.calls.length;

    themeState.current = 'dark';
    act(() => {
      root.render(<EChart option={option} ariaLabel="test chart" />);
    });

    expect(init).toHaveBeenCalledTimes(1);
    expect(chart.setOption.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('reports init errors via onError and keeps a stable container', () => {
    init.mockImplementationOnce(() => {
      throw new Error('init boom');
    });
    const onError = vi.fn();
    const { container } = setup({ onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('init boom');
    // setOption never called because init failed
    expect(chart.setOption).not.toHaveBeenCalled();
    // stable container still present
    const node = container.querySelector('[role="img"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute('aria-label')).toBe('test chart');
  });

  it('reports setOption errors via onError and keeps a stable container', () => {
    const { root, container } = setup();
    expect(chart.setOption).toHaveBeenCalledTimes(1);

    chart.setOption.mockImplementation(() => {
      throw new Error('setOption boom');
    });
    const onError = vi.fn();
    const nextOption = { series: [{ type: 'bar', data: [9] }] } as const;
    act(() => {
      root.render(<EChart option={nextOption} ariaLabel="test chart" onError={onError} />);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('setOption boom');
    // stable container still present
    const node = container.querySelector('[role="img"]');
    expect(node).not.toBeNull();
  });

  it('disables animation under prefers-reduced-motion', () => {
    matchMediaMock.mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    setup();

    expect(chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ animationDuration: 0 }),
      { notMerge: false, replaceMerge: ['series', 'xAxis', 'yAxis'] },
    );
  });

  it('applies className and default surface classes', () => {
    const { container } = setup({ className: 'extra-class' });
    const node = container.querySelector('[role="img"]');
    expect(node?.className).toContain('h-[240px]');
    expect(node?.className).toContain('min-h-[200px]');
    expect(node?.className).toContain('w-full');
    expect(node?.className).toContain('extra-class');
  });
});
