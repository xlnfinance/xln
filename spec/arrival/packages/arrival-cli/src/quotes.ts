export const QUOTES = [
  "You can't assemble an equivalent collection of heuristics in less time; experience is algorithmically incompressible.",
  "Low expectations are a self-fulfilling prophecy. If we aim high, we'll get better results.",
  "For a mind to even approach its full potential, it needs cultivation by other minds.",
  "Experience isn't merely the best teacher; it's the only teacher.",
  "Complex minds can't develop on their own. If they could, feral children would be like any other.",
  "It's essential that you behave as if your decisions matter, even though you know they don't. The reality isn't important: what's important is your belief.",
  "Despite knowing the journey and where it leads, I embrace it and welcome every moment.",
  "I couldn't tell you what it is. I can tell you what it's like. That's what language is for.",
  "There is no way of putting it in words like other studies. Suddenly, like a light that is kindled by a leaping spark, it is generated in the soul and at once sustains itself.",
  "The knowledge of things is not to be derived from names. They must be studied and investigated in themselves.",
  "Don't try to solve serious matters in the middle of the night.",
  "The problem with introspection is that it has no end.",
  "The basic tool for the manipulation of reality is the manipulation of words.",
  "The future is there, looking back at us. Trying to make sense of the fiction we will have become.",
  "We are that strange species that constructs artifacts intended to counter the natural flow of forgetting.",
  "When the past is always with you, it may as well be present; and if it is present, it will be future as well.",
  "The world is full of things more powerful than us. But if you know how to catch a ride, you can go places.",
  "All information looks like noise until you break the code.",
  "They knew many things but had no idea why. And strangely this made them more, rather than less, certain that they were right.",
  "It turns out that an eerie type of chaos can lurk just behind a facade of order - and yet, deep inside the chaos lurks an even eerier type of order.",
  "You are never dedicated to something you have complete confidence in. No one is fanatically shouting that the sun is going to rise tomorrow.",
  "You look at where you're going and where you are and it never makes sense, but then you look back at where you've been and a pattern seems to emerge.",
  "We take a handful of sand from the endless landscape of awareness around us and call that handful of sand the world.",
  "When analytic thought, the knife, is applied to experience, something is always killed in the process.",
  "Insight is not the same as wisdom. The first can be taught; the second must be earned.",
] as const;

export function pickQuote(rng: () => number = Math.random): string {
  const i = Math.min(QUOTES.length - 1, Math.max(0, Math.floor(rng() * QUOTES.length)));
  return QUOTES[i]!;
}

/** Word-wrap at `width`. Words longer than the width sit on their own line. */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(8, width);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur === "") {
      cur = word;
      continue;
    }
    if (cur.length + 1 + word.length <= max) {
      cur = `${cur} ${word}`;
      continue;
    }
    lines.push(cur);
    cur = word;
  }
  if (cur !== "") lines.push(cur);
  return lines;
}
