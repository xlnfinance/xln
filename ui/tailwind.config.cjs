/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{svelte,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: '#1a1a1a',
        panel: '#252526',
        outline: '#3e3e3e',
        accent: '#007acc'
      }
    }
  },
  plugins: []
};


