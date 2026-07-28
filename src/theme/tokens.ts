/**
 * Design tokens — the single source of truth for Mudbud's warm, earthy identity.
 * Mirrors the palette in tailwind.config.js for the places we need raw values in JS
 * (navigation theming, gradients, Reanimated interpolation, expo-image placeholders).
 */

export const colors = {
  porcelain: "#FAF5EC",

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
  kiln: {
    50: "#FFF1E6",
    100: "#FFDCC2",
    300: "#FFA766",
    400: "#FF8A3D",
    500: "#F2661F",
    600: "#D14E10",
    700: "#A63B0B",
  },
  glaze: {
    50: "#EEF3EC",
    100: "#DCE7D8",
    300: "#A9C3A0",
    500: "#6E9068",
    700: "#47624A",
    900: "#2C3E2F",
  },
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
} as const;

/** Loaded font-family names (must match keys registered in _layout via useFonts). */
export const fonts = {
  display: "Fraunces_600SemiBold",
  displayBold: "Fraunces_700Bold",
  displayItalic: "Fraunces_500Medium_Italic",
  body: "Inter_400Regular",
  bodyMedium: "Inter_500Medium",
  bodySemibold: "Inter_600SemiBold",
  bodyBold: "Inter_700Bold",
} as const;

/**
 * The pottery lifecycle. This is the app's structural spine: stage order is real
 * information (where a piece is in its journey), and each stage carries a color
 * "temperature" that warms as the piece advances toward fire.
 */
export type StageKey =
  | "throwing"
  | "trimming"
  | "greenware"
  | "bisque"
  | "glazing"
  | "firing"
  | "finished"
  | "note";

export type Stage = {
  key: StageKey;
  label: string;
  /** 0 = raw/cool clay, 6 = transformed by fire. Drives the firing color arc. */
  temp: number;
  color: string;
  /** short verb shown in the capture flow */
  hint: string;
};

export const STAGES: Stage[] = [
  { key: "throwing", label: "Throwing", temp: 0, color: colors.stone[500], hint: "On the wheel" },
  { key: "trimming", label: "Trimming", temp: 1, color: colors.stone[400], hint: "Refining the form" },
  { key: "greenware", label: "Greenware", temp: 2, color: colors.stone[300], hint: "Drying out" },
  { key: "bisque", label: "Bisque", temp: 3, color: colors.clay[400], hint: "First firing" },
  { key: "glazing", label: "Glazing", temp: 4, color: colors.glaze[500], hint: "Applying glaze" },
  { key: "firing", label: "Glaze Firing", temp: 5, color: colors.kiln[500], hint: "Into the kiln" },
  { key: "finished", label: "Fired", temp: 6, color: colors.clay[600], hint: "Out of the fire" },
  { key: "note", label: "Note", temp: 2, color: colors.stone[400], hint: "A moment worth keeping" },
];

const STAGE_MAP: Record<StageKey, Stage> = STAGES.reduce(
  (acc, s) => ({ ...acc, [s.key]: s }),
  {} as Record<StageKey, Stage>
);

export function getStage(key: string): Stage {
  return STAGE_MAP[key as StageKey] ?? STAGE_MAP.note;
}

/** Piece status shown on the shelf, derived independently of individual entries. */
export const PIECE_STATUS = {
  in_progress: { label: "In progress", color: colors.stone[400] },
  bisqued: { label: "Bisqued", color: colors.clay[400] },
  glazed: { label: "Glazed", color: colors.glaze[500] },
  finished: { label: "Fired", color: colors.clay[600] },
} as const;

export type PieceStatus = keyof typeof PIECE_STATUS;
