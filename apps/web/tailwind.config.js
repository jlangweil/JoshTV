/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: {
        // Phones in landscape: every pixel of height goes to the picture.
        short: { raw: "(max-height: 500px)" },
      },
      colors: {
        cinema: {
          bg: "#0D0D0F",
          panel: "#1A1A2E",
          accent: "#E94560",
          text: "#F5F5F0",
          muted: "#6B6B7B",
          surface: "#2A2A3E",
        },
      },
      fontFamily: {
        display: ['"DM Serif Display"', "serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
    },
  },
  plugins: [],
};
