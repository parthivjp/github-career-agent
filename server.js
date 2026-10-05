// server.js - turns the agent into a REST API (Express)
//
// Start:   npm install   then   npm run serve
// Test:    POST http://localhost:5000/api/chat
//          body: { "message": "Analyse GitHub user parthivjp", "sessionId": "me" }

const express = require("express");
const { runAgent } = require("./agent");

const app = express();
app.use(express.json());

// One conversation history per sessionId (kept in memory)
const sessions = new Map();

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "default" } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  if (!sessions.has(sessionId)) sessions.set(sessionId, []);

  const steps = []; // tool calls the agent made, so the client can show them
  try {
    const answer = await runAgent(sessions.get(sessionId), message.trim(), (line) => steps.push(line));
    res.json({ answer, steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/chat/:sessionId", (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ cleared: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Agent API running on http://localhost:${PORT}`));
