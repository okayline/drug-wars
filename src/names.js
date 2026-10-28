// Random player names: two words in dealer slang, like aura-farm's src/names.js (which it was copied from).
// Names can't be typed: every bank gets one, and can reroll it any time. No two banks share a name.
const ADJECTIVES = [
  "Shady", "Slick", "Sketchy", "Smooth", "Lucky", "Loaded", "Burnt", "Fresh", "Fly", "Wild", "Cold", "Dirty", "Corner", "Street", "Nervous",
];
const NOUNS = [
  "Plug", "Hustler", "Kingpin", "Dealer", "Capo", "Stash", "Shark", "Boss", "Cutter", "Baller", "OG", "Pusher",
];
// only the pairs of 16 characters or fewer, so names fit the LCD
const PAIRS = ADJECTIVES.flatMap((a) => NOUNS.map((n) => `${a} ${n}`)).filter((s) => s.length <= 16);

// Give this bank a random name nobody has, if it has none (or a different one, with reroll). Returns the name
// (the old one only if every try hit a taken name, which won't happen until most of the pairs are used).
export async function giveName(env, code, { reroll = false, rand = Math.random } = {}) {
  const row = await env.DB.prepare("SELECT name FROM drugwars_banks WHERE code = ?").bind(code).first();
  if (!row) return null;
  if (row.name && !reroll) return row.name;
  for (let i = 0; i < 40; i++) {
    const name = PAIRS[Math.floor(rand() * PAIRS.length)];
    if (name === row.name) continue;
    try {
      await env.DB.prepare("UPDATE drugwars_banks SET name = ?, name_key = ? WHERE code = ?").bind(name, name.toLowerCase(), code).run();
      return name;
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;   // taken: try another
    }
  }
  return row.name;
}
