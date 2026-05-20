/**
 * Built-in emoji shortcode autocomplete.
 *
 * Discord's composer turns standard `:name:` emoji choices into Unicode before
 * sending. Record does the same at completion time by inserting the emoji glyph.
 */

import type { CompletionItem } from "./commands";
import { theme } from "./theme";
import { activity, food, nature, objects, people, symbols, travel } from "discord-emoji";

export interface EmojiCandidate {
  emoji: string;
  name: string;
  aliases?: string[];
}

export interface EmojiQuery {
  start: number;
  end: number;
  query: string;
}

const EMOJI_BOUNDARY_RE = /(^|[\s([{])(:([A-Za-z0-9_+-]*))$/;
const EMOJI_QUERY_RE = /[^a-z0-9_+-]/g;

const PREFERRED_EMOJI_CANDIDATES: EmojiCandidate[] = [
  { emoji: "😭", name: "sob", aliases: ["loudly_crying", "crying"] },
  { emoji: "😂", name: "joy", aliases: ["tears_of_joy", "laughing"] },
  { emoji: "🤣", name: "rofl", aliases: ["rolling_on_the_floor_laughing"] },
  { emoji: "💀", name: "skull", aliases: ["dead"] },
  { emoji: "❤️", name: "heart", aliases: ["red_heart", "love"] },
  { emoji: "💔", name: "broken_heart" },
  { emoji: "🔥", name: "fire" },
  { emoji: "✨", name: "sparkles" },
  { emoji: "👍", name: "+1", aliases: ["thumbsup", "thumbs_up"] },
  { emoji: "👎", name: "-1", aliases: ["thumbsdown", "thumbs_down"] },
  { emoji: "🙏", name: "pray", aliases: ["please", "folded_hands"] },
  { emoji: "💯", name: "100" },
  { emoji: "👀", name: "eyes" },
  { emoji: "🤔", name: "thinking", aliases: ["thinking_face"] },
  { emoji: "🫡", name: "saluting_face", aliases: ["salute"] },
  { emoji: "🫠", name: "melting_face", aliases: ["melting"] },
  { emoji: "🫶", name: "heart_hands" },
  { emoji: "🥺", name: "pleading_face", aliases: ["pleading"] },
  { emoji: "🥹", name: "holding_back_tears" },
  { emoji: "😳", name: "flushed" },
  { emoji: "😎", name: "sunglasses" },
  { emoji: "🤓", name: "nerd", aliases: ["nerd_face"] },
  { emoji: "🤡", name: "clown", aliases: ["clown_face"] },
  { emoji: "😤", name: "triumph" },
  { emoji: "😔", name: "pensive" },
  { emoji: "😩", name: "weary" },
  { emoji: "😫", name: "tired_face" },
  { emoji: "😵", name: "dizzy_face" },
  { emoji: "😵‍💫", name: "face_with_spiral_eyes", aliases: ["dizzy"] },
  { emoji: "😱", name: "scream" },
  { emoji: "😨", name: "fearful" },
  { emoji: "😰", name: "cold_sweat" },
  { emoji: "😥", name: "disappointed_relieved" },
  { emoji: "😢", name: "cry", aliases: ["crying_face"] },
  { emoji: "😪", name: "sleepy" },
  { emoji: "😴", name: "sleeping" },
  { emoji: "🤤", name: "drooling_face", aliases: ["drooling"] },
  { emoji: "🤯", name: "exploding_head", aliases: ["mind_blown"] },
  { emoji: "🥳", name: "partying_face", aliases: ["party"] },
  { emoji: "🥰", name: "smiling_face_with_3_hearts", aliases: ["smiling_face_with_three_hearts"] },
  { emoji: "😍", name: "heart_eyes" },
  { emoji: "😘", name: "kissing_heart" },
  { emoji: "😋", name: "yum" },
  { emoji: "😜", name: "stuck_out_tongue_winking_eye" },
  { emoji: "😝", name: "stuck_out_tongue_closed_eyes" },
  { emoji: "😛", name: "stuck_out_tongue" },
  { emoji: "😐", name: "neutral_face" },
  { emoji: "😑", name: "expressionless" },
  { emoji: "🙄", name: "roll_eyes" },
  { emoji: "😬", name: "grimacing" },
  { emoji: "😮‍💨", name: "face_exhaling", aliases: ["exhale"] },
  { emoji: "😮", name: "open_mouth" },
  { emoji: "😲", name: "astonished" },
  { emoji: "😧", name: "anguished" },
  { emoji: "😦", name: "frowning" },
  { emoji: "☹️", name: "frowning_face" },
  { emoji: "🙁", name: "slightly_frowning_face" },
  { emoji: "🙂", name: "slightly_smiling_face" },
  { emoji: "😊", name: "blush" },
  { emoji: "☺️", name: "relaxed" },
  { emoji: "😀", name: "grinning" },
  { emoji: "😃", name: "smiley" },
  { emoji: "😄", name: "smile" },
  { emoji: "😁", name: "grin" },
  { emoji: "😆", name: "laughing", aliases: ["satisfied"] },
  { emoji: "😅", name: "sweat_smile" },
  { emoji: "😉", name: "wink" },
  { emoji: "🙃", name: "upside_down" },
  { emoji: "😇", name: "innocent" },
  { emoji: "🤩", name: "star_struck" },
  { emoji: "🤗", name: "hugs" },
  { emoji: "🤭", name: "hand_over_mouth" },
  { emoji: "🤫", name: "shushing_face", aliases: ["shush"] },
  { emoji: "🤐", name: "zipper_mouth_face" },
  { emoji: "😶", name: "no_mouth" },
  { emoji: "😶‍🌫️", name: "face_in_clouds" },
  { emoji: "🫥", name: "dotted_line_face" },
  { emoji: "😏", name: "smirk" },
  { emoji: "😒", name: "unamused" },
  { emoji: "😞", name: "disappointed" },
  { emoji: "😟", name: "worried" },
  { emoji: "😠", name: "angry" },
  { emoji: "😡", name: "rage", aliases: ["pout"] },
  { emoji: "🤬", name: "face_with_symbols_over_mouth", aliases: ["cursing"] },
  { emoji: "🤒", name: "face_with_thermometer" },
  { emoji: "🤕", name: "face_with_head_bandage" },
  { emoji: "🤢", name: "nauseated_face" },
  { emoji: "🤮", name: "vomiting_face" },
  { emoji: "🤧", name: "sneezing_face" },
  { emoji: "🥵", name: "hot_face" },
  { emoji: "🥶", name: "cold_face" },
  { emoji: "😈", name: "smiling_imp" },
  { emoji: "👿", name: "imp" },
  { emoji: "👻", name: "ghost" },
  { emoji: "👽", name: "alien" },
  { emoji: "🤖", name: "robot" },
  { emoji: "😺", name: "smiley_cat" },
  { emoji: "😸", name: "smile_cat" },
  { emoji: "😹", name: "joy_cat" },
  { emoji: "😻", name: "heart_eyes_cat" },
  { emoji: "😼", name: "smirk_cat" },
  { emoji: "😽", name: "kissing_cat" },
  { emoji: "🙀", name: "scream_cat" },
  { emoji: "😿", name: "crying_cat_face" },
  { emoji: "😾", name: "pouting_cat" },
  { emoji: "🙌", name: "raised_hands" },
  { emoji: "👏", name: "clap" },
  { emoji: "🤝", name: "handshake" },
  { emoji: "👊", name: "facepunch", aliases: ["punch"] },
  { emoji: "✊", name: "fist" },
  { emoji: "🤛", name: "left_facing_fist" },
  { emoji: "🤜", name: "right_facing_fist" },
  { emoji: "🤌", name: "pinched_fingers" },
  { emoji: "🤏", name: "pinching_hand" },
  { emoji: "👌", name: "ok_hand" },
  { emoji: "✌️", name: "v" },
  { emoji: "🤞", name: "crossed_fingers" },
  { emoji: "🤟", name: "love_you_gesture" },
  { emoji: "🤘", name: "metal" },
  { emoji: "👈", name: "point_left" },
  { emoji: "👉", name: "point_right" },
  { emoji: "👆", name: "point_up_2" },
  { emoji: "👇", name: "point_down" },
  { emoji: "☝️", name: "point_up" },
  { emoji: "✋", name: "hand", aliases: ["raised_hand"] },
  { emoji: "🤚", name: "raised_back_of_hand" },
  { emoji: "🖐️", name: "raised_hand_with_fingers_splayed" },
  { emoji: "🖖", name: "vulcan_salute" },
  { emoji: "👋", name: "wave" },
  { emoji: "🤙", name: "call_me_hand" },
  { emoji: "💪", name: "muscle" },
  { emoji: "🖕", name: "middle_finger" },
  { emoji: "✍️", name: "writing_hand" },
  { emoji: "🤳", name: "selfie" },
  { emoji: "💅", name: "nail_care" },
  { emoji: "🧠", name: "brain" },
  { emoji: "🫀", name: "anatomical_heart" },
  { emoji: "🫁", name: "lungs" },
  { emoji: "👅", name: "tongue" },
  { emoji: "👄", name: "lips" },
  { emoji: "💋", name: "kiss" },
  { emoji: "💘", name: "cupid" },
  { emoji: "💝", name: "gift_heart" },
  { emoji: "💖", name: "sparkling_heart" },
  { emoji: "💗", name: "heartpulse" },
  { emoji: "💓", name: "heartbeat" },
  { emoji: "💕", name: "two_hearts" },
  { emoji: "💞", name: "revolving_hearts" },
  { emoji: "💙", name: "blue_heart" },
  { emoji: "💚", name: "green_heart" },
  { emoji: "💛", name: "yellow_heart" },
  { emoji: "🧡", name: "orange_heart" },
  { emoji: "💜", name: "purple_heart" },
  { emoji: "🖤", name: "black_heart" },
  { emoji: "🤍", name: "white_heart" },
  { emoji: "🤎", name: "brown_heart" },
  { emoji: "💥", name: "boom", aliases: ["collision"] },
  { emoji: "💫", name: "dizzy" },
  { emoji: "💦", name: "sweat_drops" },
  { emoji: "💨", name: "dash" },
  { emoji: "🕳️", name: "hole" },
  { emoji: "💬", name: "speech_balloon" },
  { emoji: "💭", name: "thought_balloon" },
  { emoji: "💤", name: "zzz" },
  { emoji: "🗣️", name: "speaking_head" },
  { emoji: "🐱", name: "cat" },
  { emoji: "🐶", name: "dog" },
  { emoji: "🐭", name: "mouse" },
  { emoji: "🐹", name: "hamster" },
  { emoji: "🐰", name: "rabbit" },
  { emoji: "🦊", name: "fox_face" },
  { emoji: "🐻", name: "bear" },
  { emoji: "🐼", name: "panda_face" },
  { emoji: "🐸", name: "frog" },
  { emoji: "🐵", name: "monkey_face" },
  { emoji: "🙈", name: "see_no_evil" },
  { emoji: "🙉", name: "hear_no_evil" },
  { emoji: "🙊", name: "speak_no_evil" },
  { emoji: "🐔", name: "chicken" },
  { emoji: "🐧", name: "penguin" },
  { emoji: "🐦", name: "bird" },
  { emoji: "🦆", name: "duck" },
  { emoji: "🦅", name: "eagle" },
  { emoji: "🦉", name: "owl" },
  { emoji: "🦇", name: "bat" },
  { emoji: "🐺", name: "wolf" },
  { emoji: "🐗", name: "boar" },
  { emoji: "🐴", name: "horse" },
  { emoji: "🦄", name: "unicorn" },
  { emoji: "🐝", name: "bee" },
  { emoji: "🐛", name: "bug" },
  { emoji: "🦋", name: "butterfly" },
  { emoji: "🐌", name: "snail" },
  { emoji: "🐞", name: "lady_beetle" },
  { emoji: "🐜", name: "ant" },
  { emoji: "🪰", name: "fly" },
  { emoji: "🪱", name: "worm" },
  { emoji: "🐢", name: "turtle" },
  { emoji: "🐍", name: "snake" },
  { emoji: "🦎", name: "lizard" },
  { emoji: "🦖", name: "t_rex" },
  { emoji: "🦕", name: "sauropod" },
  { emoji: "🐙", name: "octopus" },
  { emoji: "🦑", name: "squid" },
  { emoji: "🦐", name: "shrimp" },
  { emoji: "🦞", name: "lobster" },
  { emoji: "🦀", name: "crab" },
  { emoji: "🐡", name: "blowfish" },
  { emoji: "🐠", name: "tropical_fish" },
  { emoji: "🐟", name: "fish" },
  { emoji: "🐬", name: "dolphin" },
  { emoji: "🐳", name: "whale" },
  { emoji: "🦈", name: "shark" },
  { emoji: "🍏", name: "green_apple" },
  { emoji: "🍎", name: "apple" },
  { emoji: "🍐", name: "pear" },
  { emoji: "🍊", name: "tangerine" },
  { emoji: "🍋", name: "lemon" },
  { emoji: "🍌", name: "banana" },
  { emoji: "🍉", name: "watermelon" },
  { emoji: "🍇", name: "grapes" },
  { emoji: "🍓", name: "strawberry" },
  { emoji: "🍒", name: "cherries" },
  { emoji: "🍑", name: "peach" },
  { emoji: "🍍", name: "pineapple" },
  { emoji: "🥭", name: "mango" },
  { emoji: "🥑", name: "avocado" },
  { emoji: "🍅", name: "tomato" },
  { emoji: "🍆", name: "eggplant" },
  { emoji: "🌶️", name: "hot_pepper" },
  { emoji: "🌽", name: "corn" },
  { emoji: "🥕", name: "carrot" },
  { emoji: "🧄", name: "garlic" },
  { emoji: "🧅", name: "onion" },
  { emoji: "🥔", name: "potato" },
  { emoji: "🍠", name: "sweet_potato" },
  { emoji: "🥐", name: "croissant" },
  { emoji: "🍞", name: "bread" },
  { emoji: "🧀", name: "cheese" },
  { emoji: "🥚", name: "egg" },
  { emoji: "🍳", name: "fried_egg" },
  { emoji: "🥞", name: "pancakes" },
  { emoji: "🥓", name: "bacon" },
  { emoji: "🍔", name: "hamburger" },
  { emoji: "🍟", name: "fries" },
  { emoji: "🍕", name: "pizza" },
  { emoji: "🌭", name: "hotdog" },
  { emoji: "🌮", name: "taco" },
  { emoji: "🌯", name: "burrito" },
  { emoji: "🍜", name: "ramen" },
  { emoji: "🍣", name: "sushi" },
  { emoji: "🍰", name: "cake" },
  { emoji: "🎂", name: "birthday" },
  { emoji: "🍪", name: "cookie" },
  { emoji: "🍫", name: "chocolate_bar" },
  { emoji: "🍬", name: "candy" },
  { emoji: "🍭", name: "lollipop" },
  { emoji: "🍩", name: "doughnut" },
  { emoji: "🍿", name: "popcorn" },
  { emoji: "☕", name: "coffee" },
  { emoji: "🍵", name: "tea" },
  { emoji: "🧃", name: "juice_box" },
  { emoji: "🥤", name: "cup_with_straw" },
  { emoji: "🍺", name: "beer" },
  { emoji: "🍻", name: "beers" },
  { emoji: "🥂", name: "clinking_glasses" },
  { emoji: "🍷", name: "wine_glass" },
  { emoji: "🥃", name: "tumbler_glass" },
  { emoji: "🍸", name: "cocktail" },
  { emoji: "🍹", name: "tropical_drink" },
  { emoji: "⚽", name: "soccer" },
  { emoji: "🏀", name: "basketball" },
  { emoji: "🏈", name: "football" },
  { emoji: "⚾", name: "baseball" },
  { emoji: "🎾", name: "tennis" },
  { emoji: "🏐", name: "volleyball" },
  { emoji: "🎱", name: "8ball" },
  { emoji: "🏓", name: "ping_pong" },
  { emoji: "🎮", name: "video_game" },
  { emoji: "🎲", name: "game_die" },
  { emoji: "🎯", name: "dart" },
  { emoji: "🎵", name: "musical_note" },
  { emoji: "🎶", name: "notes" },
  { emoji: "🎤", name: "microphone" },
  { emoji: "🎧", name: "headphones" },
  { emoji: "🎸", name: "guitar" },
  { emoji: "🎹", name: "musical_keyboard" },
  { emoji: "🥁", name: "drum" },
  { emoji: "🎬", name: "clapper" },
  { emoji: "🎨", name: "art" },
  { emoji: "🎭", name: "performing_arts" },
  { emoji: "🎉", name: "tada" },
  { emoji: "🎊", name: "confetti_ball" },
  { emoji: "🎁", name: "gift" },
  { emoji: "🎈", name: "balloon" },
  { emoji: "⭐", name: "star" },
  { emoji: "🌟", name: "star2" },
  { emoji: "🌙", name: "crescent_moon" },
  { emoji: "☀️", name: "sunny" },
  { emoji: "🌧️", name: "cloud_with_rain" },
  { emoji: "⛈️", name: "cloud_with_lightning_and_rain" },
  { emoji: "🌈", name: "rainbow" },
  { emoji: "☂️", name: "umbrella" },
  { emoji: "❄️", name: "snowflake" },
  { emoji: "⚡", name: "zap" },
  { emoji: "🌊", name: "ocean" },
  { emoji: "✅", name: "white_check_mark" },
  { emoji: "❌", name: "x" },
  { emoji: "⭕", name: "o" },
  { emoji: "❓", name: "question" },
  { emoji: "❔", name: "grey_question" },
  { emoji: "❗", name: "exclamation" },
  { emoji: "❕", name: "grey_exclamation" },
  { emoji: "‼️", name: "bangbang" },
  { emoji: "⁉️", name: "interrobang" },
  { emoji: "💢", name: "anger" },
  { emoji: "♻️", name: "recycle" },
  { emoji: "🔞", name: "underage" },
  { emoji: "🔴", name: "red_circle" },
  { emoji: "🟠", name: "orange_circle" },
  { emoji: "🟡", name: "yellow_circle" },
  { emoji: "🟢", name: "green_circle" },
  { emoji: "🔵", name: "large_blue_circle" },
  { emoji: "🟣", name: "purple_circle" },
  { emoji: "⚫", name: "black_circle" },
  { emoji: "⚪", name: "white_circle" },
];

type DiscordEmojiGroupName = "people" | "nature" | "food" | "activity" | "travel" | "objects" | "symbols";
type DiscordEmojiGroup = { name: DiscordEmojiGroupName; entries: Record<string, string> };

const DISCORD_EMOJI_GROUPS: DiscordEmojiGroup[] = [
  { name: "people", entries: people },
  { name: "nature", entries: nature },
  { name: "food", entries: food },
  { name: "activity", entries: activity },
  { name: "travel", entries: travel },
  { name: "objects", entries: objects },
  { name: "symbols", entries: symbols },
];

const SKIN_TONE_NAME_RE = /(?:^|_)tone[1-5](?:_|$)|skin_tone/;
const SKIN_TONE_EMOJI_RE = /[\u{1F3FB}-\u{1F3FF}]/u;
const PERSON_VARIANT_RE = /^(?:person|woman|man|women|men|people|family|couple|couplekiss|kiss_(?:woman|man|ww|mm))/;
const GENDERED_OR_PERSON_ACTIVITY_RE = /^(?:person|woman|man|women|men|people)_|_(?:woman|man|women|men)$/;
const ACTIVITY_PLAYER_RE = /^(?:lifter|weight_lifter|basketball_player|golfer|surfer|swimmer|rowboat|bicyclist|mountain_bicyclist|juggling|juggler|runner|walking|levitate)/;
const COMMON_PEOPLE_RE = /(?:face|smil|grin|laugh|joy|tear|relax|relieved|blush|innocent|wink|heart_eyes|kissing|yum|tongue|zany|eyebrow|monocle|nerd|sunglasses|disguised|star_struck|partying|smirk|unamused|disappointed|pensive|worried|confused|frown|persevere|confounded|tired|weary|pleading|cry|sob|triumph|angry|rage|pouting|symbols_over_mouth|exploding|flushed|hot|cold|scream|fearful|sweat|hug|thinking|peeking|hand_over_mouth|saluting|shushing|melting|lying|liar|no_mouth|dotted_line|diagonal_mouth|neutral|expressionless|shaking_face|grimacing|rolling_eyes|hushed|anguished|open_mouth|astonished|yawning|sleep|drool|exhaling|dizzy|spiral_eyes|zipper|woozy|nauseated|sick|vomit|sneeze|mask|thermometer|bandage|money_mouth|cowboy|imp|ogre|goblin|clown|poop|shit|hankey|poo|ghost|skull|skeleton|alien|monster|robot|jack_o_lantern|cat|shrug|facepalm|dancer)/;
const COMMON_SYMBOL_NAME_RE = /(?:heart|spark|star|zzz|anger|check|cross|mark|^x$|^o$|circle|square|diamond|question|exclamation|bangbang|interrobang|recycle|warning|underage|prohibited|stop|entry|no_|arrow|play|pause|stop_button|record|track_|fast_forward|rewind|eject|repeat|shuffle|twisted|grey|black|white|red|orange|yellow|green|blue|purple|brown|large_|small_|heavy_|plus|minus|divide|infinity|loop|wavy_dash|keycap|number_)/;
const COMMON_SYMBOL_NAMES = new Set([
  "100",
  "1234",
  "id",
  "sos",
  "ok",
  "up",
  "cool",
  "new",
  "free",
  "ng",
  "abc",
  "abcd",
  "capital_abcd",
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "hash",
  "asterisk",
  "tm",
  "copyright",
  "registered",
  "soon",
  "back",
  "end",
  "top",
]);

function isCommonDiscordEmojiAddition(groupName: DiscordEmojiGroupName, name: string, emoji: string): boolean {
  if (SKIN_TONE_NAME_RE.test(name) || SKIN_TONE_EMOJI_RE.test(emoji)) return false;

  switch (groupName) {
    case "people":
      return COMMON_PEOPLE_RE.test(name) && !PERSON_VARIANT_RE.test(name);
    case "activity":
      return !GENDERED_OR_PERSON_ACTIVITY_RE.test(name) && !ACTIVITY_PLAYER_RE.test(name);
    case "objects":
      return !GENDERED_OR_PERSON_ACTIVITY_RE.test(name);
    case "symbols":
      return COMMON_SYMBOL_NAMES.has(name) || COMMON_SYMBOL_NAME_RE.test(name);
    case "nature":
    case "food":
    case "travel":
      return true;
  }
}

function addEmojiAlias(candidate: EmojiCandidate, alias: string): void {
  const normalizedAlias = normalizeEmojiKey(alias);
  if (!normalizedAlias || normalizedAlias === normalizeEmojiKey(candidate.name)) return;

  const aliases = candidate.aliases ?? [];
  if (!aliases.some((existing) => normalizeEmojiKey(existing) === normalizedAlias)) {
    candidate.aliases = [...aliases, alias];
  }
}

function buildEmojiCandidates(): EmojiCandidate[] {
  const candidates: EmojiCandidate[] = [];
  const byEmoji = new Map<string, EmojiCandidate>();

  for (const preferred of PREFERRED_EMOJI_CANDIDATES) {
    const candidate: EmojiCandidate = { ...preferred, aliases: preferred.aliases ? [...preferred.aliases] : undefined };
    candidates.push(candidate);
    byEmoji.set(candidate.emoji, candidate);
  }

  for (const group of DISCORD_EMOJI_GROUPS) {
    for (const [name, emoji] of Object.entries(group.entries)) {
      if (SKIN_TONE_NAME_RE.test(name) || SKIN_TONE_EMOJI_RE.test(emoji)) continue;

      const existing = byEmoji.get(emoji);
      if (existing) {
        addEmojiAlias(existing, name);
        continue;
      }

      if (!isCommonDiscordEmojiAddition(group.name, name, emoji)) continue;

      const candidate: EmojiCandidate = { emoji, name };
      candidates.push(candidate);
      byEmoji.set(emoji, candidate);
    }
  }

  return candidates;
}

const EMOJI_CANDIDATES = buildEmojiCandidates();

function normalizeEmojiKey(value: string): string {
  return value.trim().toLowerCase().replace(/^:/, "").replace(/:$/, "").replace(EMOJI_QUERY_RE, "");
}

function emojiNames(candidate: EmojiCandidate): string[] {
  return [candidate.name, ...(candidate.aliases ?? [])];
}

function emojiAliases(candidate: EmojiCandidate): string[] {
  return emojiNames(candidate).map(normalizeEmojiKey).filter(Boolean);
}

function emojiCandidateMatches(candidate: EmojiCandidate, query: string): boolean {
  const key = normalizeEmojiKey(query);
  if (!key) return true;
  return emojiAliases(candidate).some((alias) => alias.startsWith(key));
}

function emojiRank(candidate: EmojiCandidate, query: string): number {
  const key = normalizeEmojiKey(query);
  if (!key) return 0;

  const primary = normalizeEmojiKey(candidate.name);
  const aliases = emojiAliases(candidate);
  if (primary === key) return 0;
  if (aliases.some((alias) => alias === key)) return 1;
  if (primary.startsWith(key)) return 2;
  if (aliases.some((alias) => alias.startsWith(key))) return 3;
  return 4;
}

function emojiDisplayName(candidate: EmojiCandidate, query: string): string {
  const key = normalizeEmojiKey(query);
  if (!key) return candidate.name;

  const names = emojiNames(candidate);
  return names.find((name) => normalizeEmojiKey(name) === key)
    ?? names.find((name) => normalizeEmojiKey(name).startsWith(key))
    ?? candidate.name;
}

export function emojiQueryAtCursor(buffer: string, cursor: number): EmojiQuery | null {
  const clampedCursor = Math.max(0, Math.min(cursor, buffer.length));
  const beforeCursor = buffer.slice(0, clampedCursor);
  const match = beforeCursor.match(EMOJI_BOUNDARY_RE);
  if (!match) return null;

  const query = match[3] ?? "";
  const start = clampedCursor - query.length - 1;
  return { start, end: clampedCursor, query };
}

export function emojiCompletions(query: string): CompletionItem[] {
  return [...EMOJI_CANDIDATES]
    .filter((candidate) => emojiCandidateMatches(candidate, query))
    .sort((left, right) => emojiRank(left, query) - emojiRank(right, query))
    .map((candidate) => ({
      name: candidate.emoji,
      desc: `:${emojiDisplayName(candidate, query)}:`,
      color: theme.text,
    }));
}
