/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--td-bg-color-page)',
        foreground: 'var(--td-text-color-primary)',
        muted: {
          DEFAULT: 'var(--td-bg-color-component)',
          foreground: 'var(--td-text-color-secondary)',
        },
        border: 'var(--td-component-stroke)',
        input: 'var(--td-bg-color-component)',
        card: {
          DEFAULT: 'var(--td-bg-color-container)',
          foreground: 'var(--td-text-color-primary)',
        },
        accent: {
          DEFAULT: 'var(--td-brand-color)',
          foreground: 'var(--td-text-color-anti)',
          light: 'var(--td-brand-color-light)',
        },
        primary: {
          DEFAULT: 'var(--td-text-color-primary)',
          foreground: 'var(--td-bg-color-page)',
        }
      },
      borderRadius: {
        'xl': '16px',
        '2xl': '20px',
      },
      /**
       * 字号整体上调一档。
       * 界面里 text-xs 用了 50+ 处、text-sm 用了 36 处，
       * 沿用 Tailwind 默认值（12 / 14px）在 1080p 及以上屏幕上明显偏小。
       * 这里只放大字号，不动 spacing，避免影响既有布局比例。
       */
      fontSize: {
        'xs': ['13px', { lineHeight: '1.45' }],
        'sm': ['15px', { lineHeight: '1.5' }],
        'base': ['17px', { lineHeight: '1.55' }],
        'lg': ['19px', { lineHeight: '1.5' }],
        'xl': ['21px', { lineHeight: '1.45' }],
        '2xl': ['25px', { lineHeight: '1.35' }],
        '3xl': ['31px', { lineHeight: '1.3' }],
      },
      animation: {
        'cursor-blink': 'blink 1s infinite',
      },
      keyframes: {
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
}
