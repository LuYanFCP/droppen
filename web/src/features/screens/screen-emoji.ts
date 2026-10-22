export const SCREEN_EMOJIS = [
  "💻", "🛠️", "🚀", "🧪", "📊", "📁", "📝", "💬",
  "🏠", "🌍", "🎯", "💡", "🎨", "🎮", "🎵", "📚",
  "🐙", "🐱", "🐶", "🦊", "🐟", "🌱", "🔥", "⭐",
] as const;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = /\p{Extended_Pictographic}|^\p{Regional_Indicator}{2}$|^[#*0-9]\uFE0F?\u20E3$/u;

/** One visible icon, not one code point: never slice joined emoji or flags. */
export function isScreenEmoji(value: string): boolean {
  const trimmed = value.trim();
  return (
    [...trimmed].length <= 32 &&
    [...graphemes.segment(trimmed)].length === 1 &&
    emoji.test(trimmed)
  );
}
