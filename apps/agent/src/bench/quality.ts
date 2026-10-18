import type { QualityCategory, QualityConfig, QualityItemResult, QualityResult } from "@irori/core";
import gsm8kData from "./data/gsm8k-200.json";
import mmluData from "./data/mmlu-285.json";
import { benchStream, labBody, thinkingOffFields } from "./stream.js";

/**
 * Quality bench — deterministic seeded suite + scoring + runner (M6).
 *
 * Every category draws from its own seeded PRNG (mulberry32) so items and ids
 * are identical on every run and two runs pair item-by-item (paired compare
 * uses exact McNemar). SUITE_VERSION gates item-set changes; SCORING_VERSION
 * gates scoring changes; compareQualityRuns refuses to pair mismatched
 * versions. GSM8K/MMLU rows are fixed MIT-licensed fixtures (data/NOTICE.md).
 */

export const SUITE_VERSION = 1;
export const SCORING_VERSION = 1;
/** Fixed `seed` field sent with every request (servers that honour it stay reproducible). */
export const REQUEST_SEED = 1234;

const QA_MAX_TOKENS = 64;
const REASON_MAX_TOKENS = 2048;
const ARITH_MAX_TOKENS = 64;
const TRACK_MAX_TOKENS = 64;
const GSM8K_MAX_TOKENS = 2048;
const MMLU_MAX_TOKENS = 1024;

// ─── PRNG ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function rngFor(key: string): () => number {
  return mulberry32(hashString(`irori-quality-v${SUITE_VERSION}:${key}`));
}

function randint(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]!;
}

export type ScoreMode = "number" | "word" | "list";

export interface QualityItem {
  id: string;
  category: QualityCategory;
  prompt: string;
  /** For number/list modes: the numeric answer(s). For word mode: the word. */
  answer: string;
  mode: ScoreMode | "gsm8k" | "mmlu";
  maxTokens: number;
  thinking: boolean;
}

// ─── QA ──────────────────────────────────────────────────

const QA_FIXED: Array<[string, string, ScoreMode]> = [
  ["What is 17 * 23? Answer with the number only.", "391", "number"],
  ["What is 1234 + 8766? Answer with the number only.", "10000", "number"],
  ["What is 2 to the power of 20? Answer with the number only.", "1048576", "number"],
  ["A train travels 180 km in 2.5 hours. What is its average speed in km/h? Number only.", "72", "number"],
  ["If x + 2x + 3x = 48, what is x? Number only.", "8", "number"],
  ["What is the remainder when 1000 is divided by 7? Number only.", "6", "number"],
  ["How many minutes are in 3.5 hours? Number only.", "210", "number"],
  ["What is the square root of 1764? Number only.", "42", "number"],
  ["What is 15% of 240? Number only.", "36", "number"],
  ["A rectangle is 12 by 7. What is its area? Number only.", "84", "number"],
  ["Reverse the string 'tensorfold'. Answer with the reversed string only.", "dlofrosnet", "word"],
  ["How many letters 'r' are in the word 'strawberry'? Number only.", "3", "number"],
  ["Sort these numbers ascending: 9, 2, 7, 4, 1. Answer as a comma-separated list.", "1, 2, 4, 7, 9", "list"],
  ["What comes next: 2, 6, 12, 20, 30, ? Number only.", "42", "number"],
  ["All bloops are razzies and all razzies are lazzies. Are all bloops lazzies? Answer yes or no.", "yes", "word"],
  ["If today is Wednesday, what day is it 10 days from now? One word.", "saturday", "word"],
  ["What is the capital of Australia? One word.", "canberra", "word"],
  ["What is the chemical symbol for gold? Symbol only.", "au", "word"],
  ["Who wrote 'Pride and Prejudice'? Name only.", "austen", "word"],
  ["What is the boiling point of water at sea level in degrees Celsius? Number only.", "100", "number"],
  ["How many sides does a hexagon have? Number only.", "6", "number"],
  ["What is the largest planet in our solar system? One word.", "jupiter", "word"],
  ["In Python, what does len([1, [2, 3], 4]) return? Number only.", "3", "number"],
  ["In Python, what is the value of 7 // 2? Number only.", "3", "number"],
  ["What is the binary representation of 13? Digits only.", "1101", "word"],
  ["What is 0.1 + 0.2 rounded to one decimal place? Number only.", "0.3", "number"],
  ["Convert 5 kilometers to meters. Number only.", "5000", "number"],
  ["What is the greatest common divisor of 84 and 36? Number only.", "12", "number"],
  ["Spell the word 'necessary' backwards. Letters only.", "yrassecen", "word"],
  ["What is 999 * 999? Number only.", "998001", "number"],
];

const COUNT_WORDS = [
  "mississippi", "bookkeeper", "banana", "committee", "parallel", "assessment",
  "successful", "occurrence", "tattoo", "referee", "balloon", "coffee", "letter",
  "address", "giraffe",
];

function genQa(): QualityItem[] {
  const items: QualityItem[] = QA_FIXED.map(([prompt, answer, mode], i) => ({
    id: `qa-${String(i + 1).padStart(3, "0")}`,
    category: "qa",
    prompt,
    answer,
    mode,
    maxTokens: QA_MAX_TOKENS,
    thinking: false,
  }));
  const rng = rngFor("qa-count");
  for (let i = 0; i < 10; i++) {
    const word = pick(rng, COUNT_WORDS);
    const letter = pick(rng, "abcdefghijklmnopqrstuvwxyz");
    const n = randint(rng, 2, 5);
    items.push({
      id: `qa-cnt-${String(i + 1).padStart(2, "0")}`,
      category: "qa",
      prompt: `How many times does the letter '${letter}' appear in the word '${word}'? Number only.`,
      answer: String([...word].filter((c) => c === letter).length),
      mode: "number",
      maxTokens: QA_MAX_TOKENS,
      thinking: false,
    });
  }
  for (let i = 0; i < 10; i++) {
    const a = randint(rng, 11, 99);
    const b = randint(rng, 11, 99);
    items.push({
      id: `qa-mul-${String(i + 1).padStart(2, "0")}`,
      category: "qa",
      prompt: `What is ${a} * ${b}? Number only.`,
      answer: String(a * b),
      mode: "number",
      maxTokens: QA_MAX_TOKENS,
      thinking: false,
    });
  }
  return items;
}

// ─── Reasoning ───────────────────────────────────────────

const REASON_FIXED: Array<[string, string]> = [
  ["Every wug is a zoomer. Some zoomers are sleepy. Can we conclude that some wugs are sleepy? Answer yes or no.", "no"],
  ["All roses are flowers. Some flowers fade quickly. Therefore some roses fade quickly. Is this conclusion logically valid? Answer yes or no.", "no"],
  ["If it rains, the street gets wet. The street is not wet. Did it rain? Answer yes or no.", "no"],
  ["Tom is taller than Sara. Sara is taller than Mia. Who is the shortest? One word.", "mia"],
  ["A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much does the ball cost, in cents? Number only.", "5"],
  ["If 5 machines make 5 widgets in 5 minutes, how many minutes do 100 machines need to make 100 widgets? Number only.", "5"],
  ["There are 25 sheep, 10 goats and a shepherd on a field. How old is the shepherd? The passage does not say. Answer: unknown.", "unknown"],
  ["Emily runs faster than Dana but slower than Priya. Who is the fastest? One word.", "priya"],
  ["A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Number only.", "9"],
  ["Some cats are black. All black things absorb heat. Do some cats absorb heat? Answer yes or no.", "yes"],
  ["Karl is older than Beth. Beth is older than Ola. Is Karl the oldest? Answer yes or no.", "yes"],
  ["Ann is standing north of Ben. Ben is standing north of Cid. Who is furthest south? One word.", "cid"],
  ["If today is Monday, what day was it 100 days ago? One word.", "saturday"],
  ["A is heavier than B. C is lighter than B. Is A heavier than C? Answer yes or no.", "yes"],
  ["Every square is a rectangle. Every rectangle has four sides. Does every square have four sides? Answer yes or no.", "yes"],
  ["A movie starts at 19:45 and runs 135 minutes. How many minutes after 19:00 does it end? Number only.", "180"],
  ["Half of 2 plus 2 equals what? Number only.", "3"],
  ["Zoe's birthday is on the 10th of March. Sam's is 15 days later. On what day of March is Sam's birthday? Number only.", "25"],
  ["If you reverse the digits of 42 and add them to 42, what is the result? Number only.", "66"],
  ["Five birds sit on a branch. A hunter shoots one. How many birds are left on the branch? Number only.", "0"],
];

function genReason(): QualityItem[] {
  return REASON_FIXED.map(([prompt, answer], i): QualityItem => ({
    id: `reason-${String(i + 1).padStart(3, "0")}`,
    category: "reason",
    prompt,
    answer: answer.toLowerCase(),
    mode: /^\d+$/.test(answer) ? "number" : "word",
    maxTokens: REASON_MAX_TOKENS,
    thinking: true,
  }));
}

// ─── Arithmetic chains ───────────────────────────────────

function genArith(): QualityItem[] {
  const rng = rngFor("arith");
  const items: QualityItem[] = [];
  for (let i = 0; i < 30; i++) {
    let value = randint(rng, 10, 99);
    const steps: string[] = [];
    for (let s = 0; s < 3; s++) {
      const op = pick(rng, ["add", "sub", "mul"]);
      const n = randint(rng, 2, op === "mul" ? 9 : 50);
      if (op === "add") {
        steps.push(`Add ${n}.`);
        value += n;
      } else if (op === "sub") {
        steps.push(`Subtract ${n}.`);
        value -= n;
      } else {
        steps.push(`Multiply by ${n}.`);
        value *= n;
      }
    }
    items.push({
      id: `arith-${String(i + 1).padStart(3, "0")}`,
      category: "arith",
      prompt: `Start with the number ${randint(rng, 10, 99)}. ${steps.join(" ")} What is the final result? Number only.`,
      answer: String(value),
      mode: "number",
      maxTokens: ARITH_MAX_TOKENS,
      thinking: false,
    });
  }
  return items;
}

// ─── State tracking ──────────────────────────────────────

const NAMES = ["Alice", "Bob", "Claire", "Dave", "Erin", "Frank", "Grace", "Henry"];
const CUPS = ["A", "B", "C"];

function genTrack(): QualityItem[] {
  const rng = rngFor("track");
  const items: QualityItem[] = [];
  // Family 1: person-to-person transfers (names rotate per item).
  for (let i = 0; i < 12; i++) {
    const rotated = [...NAMES.slice(i % NAMES.length), ...NAMES.slice(0, i % NAMES.length)];
    const [a, b, c] = rotated.slice(0, 3).map((n) => n.toLowerCase());
    const start = [randint(rng, 1, 9), randint(rng, 1, 9), randint(rng, 1, 9)];
    const give1 = randint(rng, 1, start[0]!);
    const give2 = randint(rng, 1, start[1]!);
    const target = pick(rng, [a, b, c]);
    const held: Record<string, number> = { [a]: start[0]! - give1, [b]: start[1]! - give2 + give1, [c]: start[2]! };
    items.push({
      id: `track-give-${String(i + 1).padStart(2, "0")}`,
      category: "track",
      prompt:
        `${cap(a)} has ${start[0]} apples, ${cap(b)} has ${start[1]}, and ${cap(c)} has ${start[2]}. ` +
        `${cap(a)} gives ${give1} apples to ${cap(b)}. Then ${cap(b)} gives ${give2} apples to ${cap(c)}. ` +
        `How many apples does ${cap(target)} have now? Number only.`,
      answer: String(held[target]!),
      mode: "number",
      maxTokens: TRACK_MAX_TOKENS,
      thinking: false,
    });
  }
  // Family 2: cup swaps.
  for (let i = 0; i < 12; i++) {
    const pos: Record<string, string> = { A: "red", B: "blue", C: "green" };
    const moves: string[] = [];
    for (let s = 0; s < randint(rng, 2, 4); s++) {
      const x = pick(rng, CUPS);
      let y = pick(rng, CUPS);
      while (y === x) y = pick(rng, CUPS);
      moves.push(`Swap cups ${x} and ${y}.`);
      const tmp = pos[x]!;
      pos[x] = pos[y]!;
      pos[y] = tmp;
    }
    const askBall = pick(rng, ["red", "blue", "green"]);
    const cup = Object.entries(pos).find(([, b]) => b === askBall)![0]!;
    items.push({
      id: `track-cup-${String(i + 1).padStart(2, "0")}`,
      category: "track",
      prompt:
        `Cup A holds the red ball, cup B the blue ball, cup C the green ball. ${moves.join(" ")} ` +
        `Which cup holds the ${askBall} ball now? Answer with the cup letter only.`,
      answer: cup.toLowerCase(),
      mode: "word",
      maxTokens: TRACK_MAX_TOKENS,
      thinking: false,
    });
  }
  return items;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── GSM8K / MMLU fixtures ───────────────────────────────

interface Gsm8kRow {
  n: number;
  q: string;
  a: number;
}
interface MmluRow {
  n: number;
  s: string;
  q: string;
  c: string[];
  a: string;
}

function genGsm8k(): QualityItem[] {
  return (gsm8kData as Gsm8kRow[]).map((r) => ({
    id: `gsm8k-${String(r.n).padStart(4, "0")}`,
    category: "gsm8k",
    prompt: `${r.q}\n\nSolve it step by step. End your reply with a line 'Answer: <number>' containing only the final number.`,
    answer: String(r.a),
    mode: "gsm8k",
    maxTokens: GSM8K_MAX_TOKENS,
    thinking: true,
  }));
}

function genMmlu(): QualityItem[] {
  return (mmluData as MmluRow[]).map((r) => {
    const subject = r.s.replace(/_/g, " ");
    return {
      id: `mmlu-${String(r.n).padStart(5, "0")}`,
      category: "mmlu",
      prompt:
        `The following is a multiple choice question about ${subject}.\n\n${r.q}\n` +
        r.c.map((c, i) => `${"ABCD"[i]}. ${c}`).join("\n") +
        `\n\nReply with the letter of the correct answer. End your reply with a line 'Answer: <letter>'.`,
      answer: r.a.toLowerCase(),
      mode: "mmlu",
      maxTokens: MMLU_MAX_TOKENS,
      thinking: false,
    };
  });
}

const GENERATORS: Record<QualityCategory, () => QualityItem[]> = {
  qa: genQa,
  reason: genReason,
  arith: genArith,
  track: genTrack,
  gsm8k: genGsm8k,
  mmlu: genMmlu,
};

export function generateSuite(categories: readonly QualityCategory[]): QualityItem[] {
  const items: QualityItem[] = [];
  for (const cat of categories) items.push(...GENERATORS[cat]());
  return items;
}

// ─── Scoring ─────────────────────────────────────────────

/** Drop `<think>…</think>` spans (and an unterminated trailing `</think>`). */
export function visibleAnswer(text: string): string {
  let s = String(text ?? "");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<\/think>/i.test(s)) s = s.slice(s.toLowerCase().lastIndexOf("</think>") + 8);
  const open = s.toLowerCase().indexOf("<" + "think" + ">");
  if (open >= 0) s = s.slice(0, open);
  return s.trim();
}

/** Last integer in the text (digits only, leading zeros dropped). */
export function lastInteger(text: string): string | null {
  const m = String(text ?? "").match(/\d+/g);
  if (!m) return null;
  return m[m.length - 1]!.replace(/^0+(?=\d)/, "");
}

/** Numbers in a reply, in order. Thousands commas folded ("1,234"); "1, 2, 3" is three numbers. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  const s = String(text ?? "");
  while ((m = re.exec(s))) {
    let tok = m[0];
    const prev = m.index > 0 ? s[m.index - 1]! : "";
    if (tok.startsWith("-") && /\w/.test(prev)) tok = tok.slice(1);
    const n = Number(tok.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const NEG_BEFORE = new Set([
  "not", "no", "never", "neither", "nor", "without", "except", "unlike", "than", "isn't", "wasn't", "aren't",
  "don't", "doesn't", "didn't", "can't", "cannot", "won't", "wouldn't", "shouldn't", "hardly",
]);
const NEG_AFTER = new Set(["isn't", "wasn't", "aren't", "wrong", "incorrect", "false", "untrue"]);

function negatedAt(tokens: string[], i: number, wants: string[]): boolean {
  for (let k = Math.max(0, i - 2); k < i; k++) if (NEG_BEFORE.has(tokens[k]!) && !wants.includes(tokens[k]!)) return true;
  for (let k = i + 1; k <= Math.min(tokens.length - 1, i + 2); k++) {
    if (NEG_AFTER.has(tokens[k]!)) return true;
  }
  return false;
}

/** Whole-word presence in a short, hedged-free reply (negation-aware). */
function scoreWord(reply: string, answer: string): boolean {
  const tokens = reply.toLowerCase().replace(/[^a-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length > 40) return false; // an essay is not a commitment
  const wants = [answer, ...answer.split(/\s+/)];
  const idxs = tokens.flatMap((t, i) => (wants.includes(t) ? [i] : []));
  if (idxs.length === 0) return false;
  return idxs.some((i) => !negatedAt(tokens, i, wants));
}

function scoreNumber(reply: string, answer: string): boolean {
  const nums = numbersIn(reply);
  if (nums.length === 0) return false;
  return String(nums[nums.length - 1]!) === answer.replace(/,/g, "");
}

function scoreList(reply: string, answer: string): boolean {
  const expected = answer.split(",").map((s) => Number(s.trim()));
  if (expected.length === 0) return false;
  const nums = numbersIn(reply);
  if (nums.length < expected.length) return false;
  const last = nums.slice(-expected.length);
  return last.every((n, i) => n === expected[i]);
}

function scoreGsm8k(reply: string, answer: string): boolean {
  const lines = visibleAnswer(reply).split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^answer:?\s*(-?[\d,]*\.?\d+)\s*$/i);
    if (m) return m[1]!.replace(/,/g, "") === answer;
  }
  const last = lastInteger(visibleAnswer(reply));
  return last !== null && last === answer.replace(/,/g, "");
}

function mmluLetter(line: string): string | null {
  const m = line.match(/^\(?([A-Da-d])\)?[.:)]?$/) ?? line.match(/\b([A-Da-d])\)?[.:)]?$/);
  return m ? m[1]!.toLowerCase() : null;
}

function scoreMmlu(reply: string, answer: string): boolean {
  const lines = visibleAnswer(reply).split("\n").map((l) => l.trim()).filter(Boolean);
  let last: string | null = null;
  for (const line of lines) {
    const l = mmluLetter(line);
    if (l) last = l;
  }
  if (last) return last === answer;
  const standalone = visibleAnswer(reply).match(/(?:^|[\s(])([A-D])(?=[\s).:,]|$)/);
  return standalone ? standalone[1]!.toLowerCase() === answer : false;
}

/** Score one reply against its item. Unparsable/missing answers fail. */
export function scoreItem(item: QualityItem, reply: string): boolean {
  const text = visibleAnswer(reply);
  if (!text) return false;
  switch (item.mode) {
    case "number":
      return scoreNumber(text, item.answer);
    case "word":
      return scoreWord(text, item.answer);
    case "list":
      return scoreList(text, item.answer);
    case "gsm8k":
      return scoreGsm8k(text, item.answer);
    case "mmlu":
      return scoreMmlu(text, item.answer);
  }
}

// ─── Runner ──────────────────────────────────────────────

export interface QualityHooks {
  apiKey?: string | null;
  onProgress: (index: number, total: number, label: string, liveTps: number | null) => void;
  signal: AbortSignal;
}

function qualityRequestBody(model: string | null, item: QualityItem): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model ?? undefined,
    messages: [{ role: "user", content: item.prompt }],
    max_tokens: item.maxTokens,
    temperature: 0,
    top_p: 1,
    seed: REQUEST_SEED,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (!item.thinking) Object.assign(body, thinkingOffFields());
  return body;
}

export async function runQuality(config: QualityConfig, hooks: QualityHooks): Promise<QualityResult> {
  const url = `http://${config.host}:${config.port}/v1/chat/completions`;
  const items = generateSuite(config.categories);
  const total = items.length;
  const results: QualityItemResult[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (hooks.signal.aborted) throw new Error("canceled");
      const index = next++;
      if (index >= total) return;
      const item = items[index]!;
      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      hooks.signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), 360_000);
      try {
        const res = await benchStream(url, qualityRequestBody(config.model, item), ctrl.signal, { apiKey: hooks.apiKey, stripThinkingOn400: true });
        if (res.error) {
          results.push({ id: item.id, category: item.category, pass: false, error: res.error });
        } else {
          const reply = res.content;
          // A reply that never streamed counts as an error, not a silent fail.
          if (res.ttftMs === null) {
            results.push({ id: item.id, category: item.category, pass: false, error: "no response streamed" });
          } else {
            results.push({ id: item.id, category: item.category, pass: scoreItem(item, reply), error: null });
          }
        }
      } finally {
        clearTimeout(timer);
        hooks.signal.removeEventListener("abort", onParentAbort);
        hooks.onProgress(Math.min(index + 1, total), total, `${item.category} ${Math.min(index + 1, total)}/${total}`, null);
      }
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  if (hooks.signal.aborted) throw new Error("canceled");

  // byCategory is exhaustive over all categories so persisted results stay
  // schema-valid regardless of the run's category selection.
  const byCategory: QualityResult["byCategory"] = {
    qa: { total: 0, passed: 0 },
    reason: { total: 0, passed: 0 },
    arith: { total: 0, passed: 0 },
    track: { total: 0, passed: 0 },
    gsm8k: { total: 0, passed: 0 },
    mmlu: { total: 0, passed: 0 },
  };
  for (const cat of config.categories) {
    const catItems = results.filter((r) => r.category === cat && !r.error);
    byCategory[cat] = { total: catItems.length, passed: catItems.filter((r) => r.pass).length };
  }
  return {
    suiteVersion: SUITE_VERSION,
    scoringVersion: SCORING_VERSION,
    total: results.filter((r) => !r.error).length,
    passed: results.filter((r) => !r.error && r.pass).length,
    byCategory,
    items: results,
  };
}
