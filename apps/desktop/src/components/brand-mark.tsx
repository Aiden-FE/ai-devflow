import type React from 'react';
import { cn } from '../lib/utils.js';

/**
 * ai-devflow 品牌标识（独立彩色版）。
 * 几何：右侧半圆 = 连续流转环；左侧尖角 = 代码括号「<」；四节点 = 智能节点。
 * 颜色：电光蓝/青色渐变环，蓝/青节点，紫色作为左节点克制点缀。
 */
export function BrandMark({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 64 64"
      role="img"
      aria-label="ai-devflow"
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="brand-loop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f6bff" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <path
        d="M32 15 A17 17 0 0 1 32 49 L13 32 L32 15 Z"
        fill="none"
        stroke="url(#brand-loop)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="15" r="6" fill="#1d4ed8" />
      <circle cx="49" cy="32" r="6" fill="#22d3ee" />
      <circle cx="32" cy="49" r="6" fill="#2f6bff" />
      <circle cx="13" cy="32" r="6" fill="#7c5cff" />
    </svg>
  );
}
