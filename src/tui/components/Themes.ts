import type { ServiceTheme } from '../../service/validation.js';

export interface ThemePalette {
  id: ServiceTheme;
  label: string;
  background: string;
  panel: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  selected: string;
  success: string;
  warning: string;
  error: string;
}

export const THEME_ORDER: readonly ServiceTheme[] = ['dark', 'light', 'green', 'amber'] as const;

export const THEME_LABELS: Record<ServiceTheme, string> = {
  dark: '다크',
  light: '라이트',
  green: '그린',
  amber: '앰버',
};

export const TUI_THEMES: Record<ServiceTheme, ThemePalette> = {
  dark: {
    id: 'dark',
    label: '다크',
    background: '#0F172A',
    panel: '#111827',
    text: '#E5E7EB',
    muted: '#94A3B8',
    accent: '#38BDF8',
    border: '#334155',
    selected: '#1E293B',
    success: '#34D399',
    warning: '#FBBF24',
    error: '#F87171',
  },
  light: {
    id: 'light',
    label: '라이트',
    background: '#F8FAFC',
    panel: '#FFFFFF',
    text: '#0F172A',
    muted: '#475569',
    accent: '#0284C7',
    border: '#CBD5E1',
    selected: '#E2E8F0',
    success: '#059669',
    warning: '#D97706',
    error: '#DC2626',
  },
  green: {
    id: 'green',
    label: '그린',
    background: '#071A0E',
    panel: '#0B2414',
    text: '#86EFAC',
    muted: '#4ADE80',
    accent: '#22C55E',
    border: '#166534',
    selected: '#14532D',
    success: '#4ADE80',
    warning: '#A3E635',
    error: '#F87171',
  },
  amber: {
    id: 'amber',
    label: '앰버',
    background: '#1A1005',
    panel: '#241607',
    text: '#FDE68A',
    muted: '#D97706',
    accent: '#F59E0B',
    border: '#78350F',
    selected: '#451A03',
    success: '#FBBF24',
    warning: '#FB923C',
    error: '#EF4444',
  },
};

export function getThemePalette(theme: ServiceTheme = 'dark'): ThemePalette {
  return TUI_THEMES[theme] ?? TUI_THEMES.dark;
}
