// ---------------------------------------------------------------------------
// agencypad.fun — a pump.fun launch with a mind attached.
//
// What Agency actually is, read off their own site rather than described: a
// coin launched on pump.fun (their NETWORK section names Pump and PumpSwap)
// paired with an AI "mind" that runs on a model you pick and a prompt you
// write. Their /launch page lists the fields in words - "Untitled coin
// $TICKER", "Creator fees → its own treasury", "Mind wakes at first fees",
// "Dev buy SOL · optional", "One signature" - and ships the model catalogue
// as server-rendered props.
//
// THIS PAD CANNOT MAKE AN AGENCY COIN, and the reason is worth stating exactly,
// because an earlier version of this comment got it wrong. It said Agency had
// no backend - reasoning from a /launch page whose nine chunks carry no submit
// handler and no program id. That was the wrong conclusion from a real
// observation: /coins and /coin/<mint> are server-rendered with live market
// cap, fee totals and an AWAKE flag for 200 coins, so the backend plainly
// exists. The launch form just does not ship its handler in those chunks.
//
// What their launch transaction actually is, decoded rather than described -
// and it is NOT secret. Four instructions, all on public programs:
//
//   6EF8rrect...  CreateV2                   the coin, signed and paid by YOU
//   pfeeUxB6...   CreateFeeSharingConfig     pump's own fee-sharing program
//   pfeeUxB6...   UpdateFeeShares            + MigrateBondingCurveCreator
//   6EF8rrect...  Buy                        the optional dev buy
//
// Their docs match: "You sign in Phantom; AGENCY never signs." The bonding
// curve's creator ends up as an account OWNED BY the fee-sharing program, not a
// wallet - which is the literal meaning of "keys never reachable". An earlier
// version of this comment said Agency generates a wallet and holds its key.
// That was wrong: nobody holds a key to it, because it is program-owned.
//
// And the shape is not exclusive. 2,346 coins on chain carry exactly this
// fee-sharing arrangement while Agency lists 200, and asking their own site
// about the others returns "not launched on AGENCY / no mind" despite the
// on-chain config being byte-identical apart from the mint and the payer. So
// reproducing the transaction would not produce an AGENCY coin - the on-chain
// shape cannot be the marker when thousands of non-AGENCY coins share it.
//
// What makes a coin theirs is a row in their database, written when you launch
// through their site. That is the one thing here that cannot be built.
//
// What this pad is, then: a real pump.fun launch with every pump option intact,
// the mind recorded permanently in the token's metadata, and the creator fees
// routable to a treasury of your choosing through the same argument Agency
// uses. An AGENCY-registered coin with an actual mind has to be launched on
// their site.
//
// The model list below is theirs, copied exactly: 25 models across 10
// providers, with the context window and per-turn cost they publish. Nothing
// here is invented - a model they do not list cannot be chosen, because a
// mind configured against a model their runtime has never heard of is just a
// broken coin.
// ---------------------------------------------------------------------------

/// When this catalogue was read off their page.
///
/// It matters because turnMicros is a PRICE and prices move: Kimi K3 went
/// 10334 -> 9494 and GLM 5.3 3015 -> 2355 within a day of being copied. Their
/// page sends no Access-Control-Allow-Origin, so the launcher cannot refresh
/// these from the browser - a snapshot is the only option, and calling it one
/// is the difference between a stale number and a lie.
export const AGENCY_CATALOGUE_READ = '2026-10-03';

/// Agency's model catalogue, from the `models` prop on agencypad.fun/launch.
///
/// `turnMicros` is their figure for what one turn of this model costs, in
/// millionths of a dollar - so Haiku at 8500 is $0.0085 a turn and GPT-5.5 at
/// 45000 is $0.045, a 53x spread. That is the number worth showing next to the
/// picker, because it is the difference between a mind that can afford to
/// think often and one that cannot.
export const AGENCY_MODELS = [
  { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", provider: "anthropic", context: 200000, turnMicros: 8500 },
  { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5", provider: "anthropic", context: 1000000, turnMicros: 42500 },
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", provider: "anthropic", context: 1000000, turnMicros: 34000 },
  { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", provider: "anthropic", context: 1000000, turnMicros: 17000 },
  { id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", provider: "anthropic", context: 1000000, turnMicros: 17000 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro 0423", provider: "deepseek", context: 1048576, turnMicros: 1462 },
  { id: "google/gemini-3.6-flash", name: "Google: Gemini 3.6 Flash", provider: "google", context: 1048576, turnMicros: 6375 },
  { id: "google/gemini-3.7-flash", name: "Google: Gemini 3.7 Flash", provider: "google", context: 1048576, turnMicros: 6375 },
  { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash", provider: "google", context: 1048576, turnMicros: 6375 },
  { id: "minimax/minimax-m3", name: "MiniMax: MiniMax M3", provider: "minimax", context: 1048576, turnMicros: 2400 },
  { id: "mistralai/mistral-medium-3-5", name: "Mistral: Mistral Medium 3.5", provider: "mistralai", context: 262144, turnMicros: 12750 },
  { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", provider: "moonshotai", context: 1048576, turnMicros: 9494 },
  { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5", provider: "openai", context: 1050000, turnMicros: 45000 },
  { id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna", provider: "openai", context: 1050000, turnMicros: 1800 },
  { id: "openai/gpt-5.6-sol", name: "OpenAI: GPT-5.6 Sol", provider: "openai", context: 1050000, turnMicros: 17000 },
  { id: "openai/gpt-5.6-terra", name: "OpenAI: GPT-5.6 Terra", provider: "openai", context: 1050000, turnMicros: 18000 },
  { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", provider: "openai", context: 1050000, turnMicros: 850 },
  { id: "openai/gpt-6-sol", name: "OpenAI: GPT-6 Sol", provider: "openai", context: 1050000, turnMicros: 17000 },
  { id: "openai/gpt-6.1-sol", name: "OpenAI: GPT-6.1 Sol", provider: "openai", context: 1050000, turnMicros: 17000 },
  { id: "qwen/qwen3.7-max", name: "Qwen: Qwen3.7 Max", provider: "qwen", context: 1000000, turnMicros: 11063 },
  { id: "qwen/qwen3.8-flash", name: "Qwen: Qwen3.8 Flash", provider: "qwen", context: 1000000, turnMicros: 1135 },
  { id: "qwen/qwen3.8-max-0902", name: "Qwen: Qwen3.8 Max (0902)", provider: "qwen", context: 1000000, turnMicros: 15000 },
  { id: "x-ai/grok-4.6", name: "SpaceXAI: Grok 4.6", provider: "x-ai", context: 500000, turnMicros: 15000 },
  { id: "x-ai/grok-4.7", name: "SpaceXAI: Grok 4.7", provider: "x-ai", context: 500000, turnMicros: 15000 },
  { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", provider: "z-ai", context: 1048576, turnMicros: 2355 },
];

export const AGENCY_PROVIDERS = [...new Set(AGENCY_MODELS.map((m) => m.provider))];

/// Their default, and a reasonable one: the cheapest turn of the five Claudes.
export const AGENCY_DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

export const agencyModel = (id) => AGENCY_MODELS.find((m) => m.id === id) || null;

/// What one turn costs, in dollars.
export const agencyTurnCost = (id) => {
  const m = agencyModel(id);
  return m ? m.turnMicros / 1e6 : null;
};

/// How many turns a given amount of creator fees would buy, which is the only
/// honest way to read the per-turn cost: their page says the mind wakes at the
/// first fees and runs from them, so the model choice is a burn rate.
export const agencyTurnsFor = (id, usd) => {
  const cost = agencyTurnCost(id);
  return cost && cost > 0 ? Math.floor(usd / cost) : null;
};

export const AGENCY_PROMPT_MAX = 4000;

/// The mind, as it goes into the token metadata.
///
/// Validated rather than trusted: a model outside their catalogue and an empty
/// prompt are both refused here, because both produce a coin that looks
/// launched and has nothing running it. The prompt cap is ours - their page
/// does not state one - and is set well inside every model's context window.
export function agencyMindSpec({ model, prompt, influencer = false }) {
  const m = agencyModel(model);
  if (!m) {
    throw new Error(
      `"${model}" is not one of the 25 models agencypad.fun offers. `
      + 'A mind pinned to a model their runtime does not know is a coin with nothing running it.',
    );
  }
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('an Agency launch needs a prompt — it is what the mind runs on');
  if (text.length > AGENCY_PROMPT_MAX) {
    throw new Error(`the prompt is ${text.length} characters; keep it under ${AGENCY_PROMPT_MAX}`);
  }
  return {
    platform: 'agencypad.fun',
    // Permanent once launched, by their own description, so it is recorded
    // beside the prompt rather than left to be remembered.
    model: m.id,
    modelName: m.name,
    provider: m.provider,
    context: m.context,
    turnMicros: m.turnMicros,
    prompt: text,
    influencer: !!influencer,
    version: 1,
  };
}
