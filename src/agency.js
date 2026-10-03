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
// WHAT IS NOT THERE, and this is the part that decides the shape of this pad:
// there is no backend. The whole site is nine static chunks with no async
// chunks behind them, no Solana program id anywhere, no submit handler, and a
// single /api/auth route that answers with the HTML page rather than JSON. The
// launch form renders and has nothing to post to. So there is no service to
// register a mind with, and this pad does not pretend otherwise.
//
// What it does instead: launch the real coin on pump.fun - the same path the
// pump pad uses, so every pump option still applies - and write the mind's
// configuration into the token's own metadata, which is the one place it is
// permanent, public and readable by whoever ends up running it. If Agency
// later exposes an endpoint, the spec built here is what gets posted to it.
//
// The model list below is theirs, copied exactly: 25 models across 10
// providers, with the context window and per-turn cost they publish. Nothing
// here is invented - a model they do not list cannot be chosen, because a
// mind configured against a model their runtime has never heard of is just a
// broken coin.
// ---------------------------------------------------------------------------

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
  { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", provider: "moonshotai", context: 1048576, turnMicros: 10334 },
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
  { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", provider: "z-ai", context: 1048576, turnMicros: 3015 },
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
