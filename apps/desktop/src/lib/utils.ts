// clsx + tailwind-merge：合并 className，后者解决 tailwind 工具类冲突。
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
