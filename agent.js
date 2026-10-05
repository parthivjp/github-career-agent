// agent.js - GitHub Career Agent (Node.js 18+, Gemini API)
//
// What makes it a real agent:
//   - It PLANS: decides which tools to call and in what order.
//   - It runs several tools AT THE SAME TIME (parallel tool calls).
//   - It REMEMBERS the chat (history), so you can ask follow-up questions.
//   - It recovers from errors (tool errors go back to the AI, API errors are retried).
//
// Run (Command Prompt):
//   set GEMINI_API_KEY=your_key
//   node agent.js "Analyse GitHub user parthivjp and save resume points to resume.md"
//   node agent.js            <- chat mode (type "exit" to quit)

const readline = require("readline/promises");
const { tools, toolDeclarations } = require("./tools");

// Comma-separated list. The agent moves to the next model when one is out of quota.
// Example: set GEMINI_MODEL=gemini-2.5-flash,gemini-2.5-flash-lite
const MODELS = (process.env.GEMINI_MODEL || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
let modelIndex = 0; // sticks to the model that works
const MAX_STEPS = 12;

const SYSTEM_PROMPT = `You are a career assistant for software developers.
You can read public GitHub data with your tools.

How to work:
1. Call list_repos first to see the projects.
2. Pick the 3 to 5 strongest projects (real apps, recent, clear description).
3. Call get_readme (and get_languages if useful) for those projects. Ask for several at the same time.
4. Write the result. Resume bullet points must:
   - start with an action verb (Built, Designed, Integrated, Deployed...)
   - mention the technologies
   - use only facts you found in the README or repo data. Never invent numbers or features.
5. If the user wants the result saved, call write_file with a .md file name.
Keep answers short and clear. If a tool returns an error, say so and continue with what you have.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Call the Gemini API ----------
// - 503 (busy) and short 429 (per-minute limit): wait and retry the same model
// - daily-quota 429 or model not found (404): switch to the next model
// - anything else: stop with a clear error
function retryDelaySeconds(errText) {
  try {
    const info = (JSON.parse(errText).error?.details || []).find((d) => d.retryDelay);
    if (info) return parseFloat(info.retryDelay); // e.g. "15s"
  } catch {}
  return null;
}

async function callGemini(contents) {
  if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY first.");

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    tools: [{ functionDeclarations: toolDeclarations }],
  });

  const MAX_TRIES = 4;
  let lastError = "";

  while (modelIndex < MODELS.length) {
    const model = MODELS[modelIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    let switchModel = false;

    for (let attempt = 1; attempt <= MAX_TRIES && !switchModel; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body,
      });
      if (res.ok) return res.json();

      const errText = await res.text();
      lastError = `Gemini API error ${res.status} (${model}): ${errText.slice(0, 400)}`;

      if (res.status === 404) { switchModel = true; break; }

      if (res.status === 429) {
        const delay = retryDelaySeconds(errText);
        const dailyQuota = /PerDay|free_tier_requests|RESOURCE_EXHAUSTED/.test(errText) && (delay === null || delay > 60);
        if (dailyQuota) { switchModel = true; break; }
        if (attempt < MAX_TRIES) {
          const wait = Math.min(Math.ceil(delay || attempt * 5), 60);
          console.log(`Rate limit on ${model}. Waiting ${wait}s... (${attempt}/${MAX_TRIES - 1})`);
          await sleep(wait * 1000);
          continue;
        }
        switchModel = true; break;
      }

      if ([500, 503].includes(res.status)) {
        if (attempt < MAX_TRIES) {
          const wait = attempt * 3;
          console.log(`${model} is busy (${res.status}). Retrying in ${wait}s... (${attempt}/${MAX_TRIES - 1})`);
          await sleep(wait * 1000);
          continue;
        }
        switchModel = true; break;
      }

      throw new Error(lastError); // 400, 401, 403 ... retrying will not help
    }

    modelIndex++;
    if (modelIndex < MODELS.length) console.log(`Switching to model: ${MODELS[modelIndex]}`);
  }

  throw new Error(
    "All models failed or are out of free quota.\n" + lastError +
    "\nTry: wait for the quota reset, set GEMINI_MODEL to another model (node agent.js --models), or use an API key from a new project."
  );
}

async function listModels() {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY || "" },
  });
  if (!res.ok) throw new Error(`Could not list models: ${res.status} ${await res.text()}`);
  const { models } = await res.json();
  models
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .forEach((m) => console.log(m.name.replace("models/", "")));
}

// ---------- The agent loop ----------
// history = the whole conversation so far (kept between questions = memory)
async function runAgent(history, userMessage, log = console.log) {
  history.push({ role: "user", parts: [{ text: userMessage }] });

  for (let step = 1; step <= MAX_STEPS; step++) {
    const data = await callGemini(history);
    const content = data.candidates?.[0]?.content;
    if (!content) throw new Error("No answer from Gemini: " + JSON.stringify(data.promptFeedback || data));

    history.push(content);

    const calls = (content.parts || []).filter((p) => p.functionCall);

    // No tool requested -> this is the final answer
    if (calls.length === 0) {
      return (content.parts || []).map((p) => p.text || "").join("").trim() || "(no answer)";
    }

    // Run all requested tools at the same time
    const results = await Promise.all(
      calls.map(async ({ functionCall: { name, args } }) => {
        log(`[step ${step}] ${name}(${JSON.stringify(args || {})})`);
        let response;
        try {
          if (!tools[name]) throw new Error("Unknown tool: " + name);
          response = { result: await tools[name].run(args || {}) };
        } catch (err) {
          response = { error: err.message }; // the AI sees the error and can adapt
          log(`           failed: ${err.message}`);
        }
        return { functionResponse: { name, response } };
      })
    );

    history.push({ role: "user", parts: results });
  }
  return "Stopped: the agent used too many steps. Try a smaller request.";
}

// ---------- Command line ----------
async function main() {
  if (process.argv[2] === "--models") return listModels();
  const oneShot = process.argv.slice(2).join(" ");
  const history = [];

  if (oneShot) {
    console.log("Question:", oneShot, "\n");
    console.log("\nAnswer:\n" + (await runAgent(history, oneShot)));
    return;
  }

  // Chat mode: the same history is reused, so the agent remembers earlier answers
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('GitHub Career Agent. Type "exit" to quit.\n');
  while (true) {
    const q = (await rl.question("You: ")).trim();
    if (!q) continue;
    if (q.toLowerCase() === "exit") break;
    try {
      console.log("\nAgent: " + (await runAgent(history, q)) + "\n");
    } catch (err) {
      console.error("Error:", err.message, "\n");
    }
  }
  rl.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { runAgent };
