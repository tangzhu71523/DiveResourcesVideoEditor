/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // DIVE RESOURCES brand palette (unchanged).
        dive: {
          950: '#0a1523',
          900: '#0f1f33',
          800: '#16304f',
          700: '#1e3a5f',
          600: '#2a5186',
          500: '#3b82f6',
          400: '#60a5fa',
          300: '#93c5fd',
          200: '#bfdbfe',
          100: '#dbeafe',
          50:  '#eff6ff',
        },
        ruler: {
          bg: 'rgb(var(--ruler-bg) / <alpha-value>)',
          fg: '#ffffff',
        },
        // Theme tokens — pull from CSS variables so swap is one attribute change.
        app:     'rgb(var(--bg-app) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          raised:  'rgb(var(--bg-raised) / <alpha-value>)',
          sunken:  'rgb(var(--bg-sunken) / <alpha-value>)',
        },
        'border-subtle': 'rgb(var(--border-subtle) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        'text-primary':   'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        'text-muted':     'rgb(var(--text-muted) / <alpha-value>)',
        'accent-500': 'rgb(var(--accent-500) / <alpha-value>)',
        'accent-400': 'rgb(var(--accent-400) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '"Inter Variable"', '"Inter"',
          '"PingFang SC"', '"Microsoft YaHei UI"', '"Microsoft YaHei"',
          'system-ui', 'sans-serif',
        ],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.2), 0 4px 12px rgb(0 0 0 / 0.25)',
        cardHover: '0 8px 24px rgb(0 0 0 / 0.35)',
        ring: '0 0 0 1px rgb(255 255 255 / 0.06)',
        glow: '0 0 0 1px rgb(59 130 246 / 0.4), 0 4px 14px rgb(59 130 246 / 0.25)',
      },
      borderRadius: {
        card: '10px',
        modal: '14px',
      },
      transitionTimingFunction: {
        swift: 'cubic-bezier(.2,.8,.2,1)',
      },
    },
  },
  plugins: [],
}
