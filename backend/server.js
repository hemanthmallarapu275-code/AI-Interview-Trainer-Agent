const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ───────────────────────────────────────────────────────────────────
const WATSONX_URL =
  "https://eu-de.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29";
const MODEL_ID    = "ibm/granite-4-h-small";
const PROJECT_ID  = "1a0e8eaf-318d-4e43-bb1e-f40ece288624";
const API_KEY     = "SlFIAtajsWKfLs-z53g2uTrbb0Z0W6IRRewl9LJabRKG";

const MAX_REACT_STEPS = 6; // safety ceiling on reasoning iterations

// ── IAM token cache ───────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getIAMToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await axios.post(
    "https://iam.cloud.ibm.com/identity/token",
    new URLSearchParams({
      grant_type: "urn:ibm:params:oauth:grant-type:apikey",
      apikey: API_KEY,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  cachedToken = resp.data.access_token;
  tokenExpiry  = Date.now() + (resp.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Raw LLM call ──────────────────────────────────────────────────────────────
async function llm(prompt, maxTokens = 512) {
  const token = await getIAMToken();
  const resp  = await axios.post(
    WATSONX_URL,
    {
      model_id:   MODEL_ID,
      project_id: PROJECT_ID,
      input:      prompt,
      parameters: {
        decoding_method:    "greedy",
        max_new_tokens:     maxTokens,
        min_new_tokens:     10,
        repetition_penalty: 1.1,
        stop_sequences:     ["Observation:"],   // halt generation at next Observation
      },
    },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  return resp.data.results[0].generated_text.trim();
}

// ── Tool registry ─────────────────────────────────────────────────────────────
//
// Each tool is a plain async function.
// The ReAct loop identifies which tool to call by name and passes a JSON args
// object parsed straight from the model output.
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = {

  generate_interview_questions: {
    description:
      "Generate tailored interview questions from a job description. " +
      "Args: { job_description: string, num_questions?: number, difficulty?: 'easy'|'medium'|'hard' }",
    async run({ job_description, num_questions = 5, difficulty = "medium" }) {
      const prompt =
        `You are an expert interview coach. Given the job description below, generate ` +
        `${num_questions} ${difficulty}-difficulty interview questions covering technical skills, ` +
        `behavioural traits, and cultural fit. Number each question.\n\n` +
        `Job Description:\n${job_description}\n\nInterview Questions:`;
      const text = await llm(prompt, 700);
      const questions = text
        .split("\n")
        .filter((l) => /^\d+[.)]\s/.test(l.trim()))
        .map((l) => l.trim());
      return questions.length ? questions.join("\n") : text;
    },
  },

  evaluate_interview_answer: {
    description:
      "Evaluate a candidate's answer and give structured feedback (score/10, strengths, " +
      "improvements, model answer). " +
      "Args: { question: string, answer: string, job_description?: string }",
    async run({ question, answer, job_description = "General role" }) {
      const prompt =
        `You are an expert interview coach. Evaluate the candidate answer below.\n` +
        `Provide exactly: 1) Score out of 10  2) Strengths  3) Areas for improvement  4) Model answer.\n\n` +
        `Job Context: ${job_description}\nQuestion: ${question}\nCandidate Answer: ${answer}\n\nEvaluation:`;
      return await llm(prompt, 600);
    },
  },

  generate_study_plan: {
    description:
      "Create a personalised 2-week interview preparation study plan. " +
      "Args: { job_description: string, weak_areas?: string }",
    async run({ job_description, weak_areas = "general preparation" }) {
      const prompt =
        `You are a career coach. Create a 2-week interview preparation study plan for the role below. ` +
        `Focus on: ${weak_areas}. Include daily tasks, resources, and practice tips.\n\n` +
        `Job Description:\n${job_description}\n\nStudy Plan:`;
      return await llm(prompt, 900);
    },
  },

  get_interview_tips: {
    description:
      "Provide expert interview tips for a specific role or topic. " +
      "Args: { role_or_topic: string, interview_type?: 'general'|'technical'|'behavioural'|'case' }",
    async run({ role_or_topic, interview_type = "general" }) {
      const prompt =
        `You are an expert career coach. Give 8 concise, actionable ${interview_type} interview tips ` +
        `for the role: ${role_or_topic}.\n\nTips:`;
      return await llm(prompt, 500);
    },
  },

};

// ── ReAct system prompt ───────────────────────────────────────────────────────
//
// Format the model must follow every turn:
//   Thought: <reasoning>
//   Action: <tool_name>
//   Action Input: <json args>
//   Observation: <tool result>   ← injected by us, not generated
//   ... (repeat until ready)
//   Thought: I now have enough information.
//   Final Answer: <answer>
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const toolDocs = Object.entries(TOOLS)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join("\n");

  return `You are an expert Interview Training Agent powered by IBM watsonx Granite.
Help users prepare for job interviews by generating questions, evaluating answers,
creating study plans, and giving tips.

You have access to the following tools:
${toolDocs}

Use the following format STRICTLY:

Thought: think about what to do
Action: the tool name to call (exactly as listed above)
Action Input: {"arg1": "value1", ...}
Observation: <result of the tool — provided to you>
... (repeat Thought/Action/Action Input/Observation as needed)
Thought: I now have enough information to answer.
Final Answer: your complete, helpful response to the user

RULES:
- Always start with a Thought.
- Use a tool whenever it would improve your answer.
- Never fabricate an Observation — wait for it.
- When you have all the information, write "Final Answer:" to finish.
`;
}

// ── ReAct loop ────────────────────────────────────────────────────────────────
async function reactLoop(userMessage, history = []) {
  const system = buildSystemPrompt();

  // Build the running transcript
  // history = [{role:'user'|'assistant', content:string}, ...]
  const historyText = history
    .map((m) => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`))
    .join("\n");

  let scratchpad = ""; // accumulates Thought/Action/Observation turns
  const trace   = []; // returned to caller for transparency

  for (let step = 0; step < MAX_REACT_STEPS; step++) {
    // ── Build full prompt ────────────────────────────────────────────────────
    const prompt =
      system +
      (historyText ? `\n\nConversation so far:\n${historyText}\n` : "") +
      `\nUser: ${userMessage}\n` +
      (scratchpad || "") +
      "\nThought:";

    // ── Ask the model for next Thought + Action ───────────────────────────────
    const raw = await llm(prompt, 400);
    const block = "Thought:" + raw; // re-attach the prefix we used as stop

    trace.push({ type: "think", text: block });

    // ── Check for Final Answer ────────────────────────────────────────────────
    const finalMatch = block.match(/Final Answer:\s*([\s\S]+)/i);
    if (finalMatch) {
      return { answer: finalMatch[1].trim(), trace };
    }

    // ── Parse Action + Action Input ───────────────────────────────────────────
    const actionMatch     = block.match(/Action:\s*(\w+)/i);
    const actionInputMatch = block.match(/Action Input:\s*(\{[\s\S]*?\})/i);

    if (!actionMatch) {
      // Model didn't call a tool — treat last text as final answer
      scratchpad += "\n" + block;
      return { answer: block.replace(/Thought:.*\n?/i, "").trim(), trace };
    }

    const toolName = actionMatch[1].trim();
    let toolArgs   = {};
    if (actionInputMatch) {
      try { toolArgs = JSON.parse(actionInputMatch[1]); } catch { /* ignore parse error */ }
    }

    trace.push({ type: "action", tool: toolName, args: toolArgs });

    // ── Execute the tool ──────────────────────────────────────────────────────
    let observation;
    const tool = TOOLS[toolName];
    if (!tool) {
      observation = `Error: unknown tool "${toolName}". Available: ${Object.keys(TOOLS).join(", ")}`;
    } else {
      try {
        observation = await tool.run(toolArgs);
      } catch (err) {
        observation = `Tool error: ${err.message}`;
      }
    }

    trace.push({ type: "observation", tool: toolName, result: observation });

    // ── Append to scratchpad ──────────────────────────────────────────────────
    scratchpad +=
      "\n" + block +
      `\nObservation: ${observation}\n`;
  }

  // Exceeded MAX_REACT_STEPS — ask model to summarise what it has
  const finalPrompt =
    buildSystemPrompt() +
    `\nUser: ${userMessage}\n` +
    scratchpad +
    "\nThought: I have gathered enough information. Final Answer:";
  const finalRaw = await llm(finalPrompt, 600);
  return { answer: finalRaw.trim(), trace };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/chat
 * Primary ReAct-powered endpoint.
 * Body: { message: string, history?: [{role, content}] }
 * Returns: { answer: string, trace: [...] }
 */
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });
  try {
    const result = await reactLoop(message, history);
    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "ReAct loop failed: " + err.message });
  }
});

/**
 * POST /api/generate-questions  (thin wrapper — kept for frontend direct use)
 */
app.post("/api/generate-questions", async (req, res) => {
  const { jobDescription, numQuestions = 5, difficulty = "medium" } = req.body;
  if (!jobDescription) return res.status(400).json({ error: "jobDescription is required" });
  try {
    const text = await TOOLS.generate_interview_questions.run({
      job_description: jobDescription, num_questions: numQuestions, difficulty,
    });
    const questions = text.split("\n").filter((l) => /^\d+[.)]\s/.test(l.trim())).map((l) => l.trim());
    res.json({ questions: questions.length ? questions : text.split("\n").filter(Boolean) });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to generate questions" });
  }
});

/**
 * POST /api/evaluate-answer  (thin wrapper)
 */
app.post("/api/evaluate-answer", async (req, res) => {
  const { question, answer, jobDescription } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "question and answer are required" });
  try {
    const feedback = await TOOLS.evaluate_interview_answer.run({
      question, answer, job_description: jobDescription,
    });
    res.json({ feedback });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to evaluate answer" });
  }
});

/**
 * POST /api/study-plan  (thin wrapper)
 */
app.post("/api/study-plan", async (req, res) => {
  const { jobDescription, weakAreas } = req.body;
  if (!jobDescription) return res.status(400).json({ error: "jobDescription is required" });
  try {
    const plan = await TOOLS.generate_study_plan.run({
      job_description: jobDescription, weak_areas: weakAreas,
    });
    res.json({ plan });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to generate study plan" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Interview Training API (ReAct) running on port ${PORT}`));
