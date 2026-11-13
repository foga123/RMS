/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46', // PHINMA COC Green Base
          900: '#064e3b',
          950: '#022c22', // Darker green
        },
        slate: {
          850: '#151e2e',
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        heading: ['Outfit', 'sans-serif'],
      },
      /*
       * The type scale, in px, matching src/shared/theme/tokens.js `font.size`.
       *
       * Tailwind's defaults are in `rem`, which resolves against the root — and
       * the root here is 87.5% (14px), not 16px. So `text-sm` was 12.25px while
       * the token scale's neighbouring step was 12.5px, and `text-lg` was
       * 15.75px against a token 16px. Every such pair rendered as two different
       * sizes that nobody could tell apart but that made the page measurably
       * inconsistent: a sweep of five screens found 18 distinct text sizes,
       * seven of them inside a 2.5px band.
       *
       * Pinning the utilities to the token numbers collapses those duplicates
       * without moving any text more than a pixel. px rather than rem on
       * purpose: rem here would re-introduce the same root-relative drift the
       * responsive root-size clamp already varies between 13px and 14px.
       */
      fontSize: {
        xs: ['10.5px', { lineHeight: '1.45' }],
        sm: ['11.5px', { lineHeight: '1.45' }],
        base: ['14px', { lineHeight: '1.5' }],
        lg: ['16px', { lineHeight: '1.4' }],
        xl: ['19.5px', { lineHeight: '1.3' }],
        '2xl': ['24.5px', { lineHeight: '1.25' }],
        '3xl': ['30px', { lineHeight: '1.2' }],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.5s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        }
      }
    },
  },
  plugins: [],
}
