import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
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
