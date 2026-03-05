/**
 * Shared design tokens as a Tailwind CSS preset.
 * Compositions extend this via `presets: [flowFrameworkPreset]`.
 */
export const flowFrameworkPreset = {
  theme: {
    extend: {
      colors: {
        bg: { base: '#1a1815', raised: '#201d18', surface: '#2b2a27', overlay: '#343230' },
        border: { subtle: '#302e2b', DEFAULT: '#3d3a36', strong: '#4a4742', active: '#5a5650' },
        text: { primary: '#e8e6e3', secondary: '#b1ada1', tertiary: '#8a8578', muted: '#8a8578' },
        status: {
          blue: '#60a5fa', 'blue-bg': '#1a2a40',
          green: '#4ade80', 'green-bg': '#1a3528',
          red: '#f87171', 'red-bg': '#3a1a1a',
          amber: '#fbbf24', 'amber-bg': '#352a15',
          purple: '#c084fc', 'purple-bg': '#2a1845',
          orange: '#fb923c', 'orange-bg': '#3a2515',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Cascadia Code"', '"Fira Code"', 'monospace'],
      },
      fontSize: { '2xs': '0.6875rem' },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.15)',
        'card-hover': '0 2px 8px rgba(0,0,0,0.2), 0 12px 28px rgba(0,0,0,0.18)',
        dialog: '0 8px 40px rgba(0,0,0,0.4), 0 0 1px rgba(255,255,255,0.03)',
        'glow-blue': '0 0 20px rgba(59,130,246,0.15), 0 0 40px rgba(59,130,246,0.05)',
        'glow-green': '0 0 20px rgba(74,222,128,0.15)',
        'glow-red': '0 0 20px rgba(248,113,113,0.15)',
      },
      borderRadius: { sm: '6px', DEFAULT: '8px', lg: '12px', xl: '16px', '2xl': '20px' },
      animation: {
        'pulse-status': 'pulse-status 1.5s ease-in-out infinite',
        'blink-cursor': 'blink-cursor 1s step-end infinite',
        shimmer: 'shimmer 2s linear infinite',
        'fade-in': 'fade-in 200ms ease',
        'slide-up': 'slide-up 200ms ease',
        'card-enter': 'cardEnter 300ms cubic-bezier(0.16,1,0.3,1) both',
      },
      keyframes: {
        'pulse-status': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
        'blink-cursor': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { transform: 'translateY(4px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        cardEnter: {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
    },
  },
};
