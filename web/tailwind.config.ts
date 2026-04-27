import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  // Tremor uses dynamically-built classes like `stroke-blue-500`, `fill-cyan-500`
  // for chart colors. Tailwind purges utilities not seen literally in source —
  // including ones built at runtime by Tremor. Safelist every chart color
  // utility so SVG strokes/fills/text actually render.
  safelist: [
    {
      pattern: /^(stroke|fill|text|bg|border)-(blue|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|orange|amber|yellow|lime|green|emerald|teal|red|gray|slate|zinc|neutral)-(50|100|200|300|400|500|600|700|800|900)$/,
      variants: ['dark'],
    },
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        gantri: {
          ink: '#0E0E0E',
          paper: '#FAFAFA',
          accent: '#0066FF',
        },
      },
    },
  },
  plugins: [],
};
export default config;
