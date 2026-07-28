/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Warm off-white grounds — "porcelain"/bisque, the canvas the photos sit on.
        porcelain: "#FAF5EC",
        // Clay: the primary terracotta identity color.
        clay: {
          50: "#FBF0E9",
          100: "#F6DDCE",
          200: "#EDBBA0",
          300: "#E19A73",
          400: "#D6784A",
          500: "#C15A2E",
          600: "#A0471F",
          700: "#7E3818",
          800: "#5C2911",
          900: "#3B1A0B",
        },
        // Kiln: hot ember glow, reserved for primary CTAs and "firing" moments.
        kiln: {
          50: "#FFF1E6",
          100: "#FFDCC2",
          300: "#FFA766",
          400: "#FF8A3D",
          500: "#F2661F",
          600: "#D14E10",
          700: "#A63B0B",
        },
        // Glaze: cool celadon/sage, the calm contrast accent.
        glaze: {
          50: "#EEF3EC",
          100: "#DCE7D8",
          300: "#A9C3A0",
          500: "#6E9068",
          700: "#47624A",
          900: "#2C3E2F",
        },
        // Stone: warm-tinted neutrals for text, borders, muted surfaces.
        stone: {
          50: "#F7F3EC",
          100: "#EDE6DA",
          200: "#DDD3C4",
          300: "#C4B7A4",
          400: "#A0917D",
          500: "#7E6F5C",
          600: "#5E5142",
          700: "#443A2E",
          800: "#2E271E",
          900: "#1C1712",
        },
      },
      fontFamily: {
        // Fraunces — soft, characterful display serif (the "signature").
        display: ["Fraunces_600SemiBold"],
        "display-bold": ["Fraunces_700Bold"],
        "display-italic": ["Fraunces_500Medium_Italic"],
        // Inter — clean, legible UI sans for body/labels.
        body: ["Inter_400Regular"],
        "body-medium": ["Inter_500Medium"],
        "body-semibold": ["Inter_600SemiBold"],
        "body-bold": ["Inter_700Bold"],
      },
      borderRadius: {
        pill: "999px",
      },
    },
  },
  plugins: [],
};
