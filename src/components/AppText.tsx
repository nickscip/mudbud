import { Text, type TextProps } from "react-native";

type Variant =
  | "display" // Fraunces — screen & piece titles
  | "displayItalic" // Fraunces italic — quiet, warm accents
  | "title" // Inter semibold — section titles, card titles
  | "body" // Inter — running text
  | "label" // Inter medium — labels, metadata
  | "caption"; // Inter — small, muted

const VARIANTS: Record<Variant, string> = {
  display: "font-display text-stone-800",
  displayItalic: "font-display-italic text-stone-700",
  title: "font-body-semibold text-stone-800",
  body: "font-body text-stone-700",
  label: "font-body-medium text-stone-500",
  caption: "font-body text-stone-400",
};

export type AppTextProps = TextProps & {
  variant?: Variant;
  className?: string;
};

/** Typed text primitive so every label pulls from the same type system. */
export function Txt({ variant = "body", className, ...props }: AppTextProps) {
  return <Text className={`${VARIANTS[variant]} ${className ?? ""}`} {...props} />;
}
