import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#22c55e',
        quote: '#3b82f6',
      },
    },
  },
  plugins: [],
};

export default config;
