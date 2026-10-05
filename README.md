# GitHub Career Agent

An AI agent built with **Node.js** and the **Gemini API (function calling)**. Give it a GitHub username and it reads the user's public repositories, picks the strongest projects, reads their READMEs, and writes resume bullet points to a Markdown file.

It runs as a command-line tool (one-shot or chat mode) and as a REST API built with Express.

## Features

- **Tool use / planning** - the model decides which tools to call and in what order.
- **Parallel tool calls** - several READMEs and language lists are fetched at the same time.
- **Error recovery** - if a tool fails (for example a repo is not found), the error goes back to the model and it continues with what it has.
- **Conversation memory** - in chat mode and API mode the agent remembers earlier messages, so you can say "make it shorter".
- **Resilient API client** - retries when Gemini is busy (503) or rate limited (429), and switches to the next model when one runs out of free quota.
- **Safe file writing** - the agent can only write `.md` or `.txt` files with a plain file name, inside the `output/` folder.
- **REST API** - separate memory per `sessionId`.

## Tools

| Tool | What it does |
|------|--------------|
| `list_repos` | Lists a user's public, non-fork repositories (name, description, language, stars, last update) |
| `get_readme` | Reads a repository README (cleaned, first 3500 characters). Small spelling mistakes in the repo name are matched against the real repo list |
| `get_languages` | Gets the languages used in a repository |
| `write_file` | Saves the final report to `output/<name>.md` or `.txt` |

## How it works

```
User message
     |
     v
Gemini (with tool definitions)
     |-- asks for tools ---> run all requested tools in parallel
     |                              |
     |<---- tool results ------------
     |
     v
Final answer (loop stops, max 12 steps)
```

1. The user message is added to the conversation history.
2. Gemini replies either with tool calls or with a final answer.
3. Tool calls run in parallel with `Promise.all`. Their results (or errors) are added to the history.
4. The loop repeats until Gemini answers without tool calls, or the step limit is reached.

## Project structure

```
agent.js       Agent loop, Gemini client, command-line interface
tools.js       Tool definitions and implementations
server.js      Express REST API
package.json
```

## Requirements

- Node.js 18 or newer
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- Optional: a GitHub token (raises the GitHub limit from 60 to 5000 requests per hour)

## Setup

```bash
git clone https://github.com/<your-username>/github-career-agent.git
cd github-career-agent
npm install
```

Set your API key.

Windows (Command Prompt):

```bat
set GEMINI_API_KEY=your_key
set GITHUB_TOKEN=your_token
```

macOS / Linux:

```bash
export GEMINI_API_KEY=your_key
export GITHUB_TOKEN=your_token
```

`GITHUB_TOKEN` is optional. Never commit your keys to the repository.

## Usage

### One-shot

```bash
node agent.js "Analyse GitHub user <username> and save resume points to resume.md"
```

The file is saved to `output/resume.md`.

### Chat mode

```bash
node agent.js
```

Type `exit` to quit. Follow-up questions work because the history is kept.

### REST API

```bash
npm run serve
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/chat` | Send a message. Body: `{ "message": "...", "sessionId": "me" }` |
| DELETE | `/api/chat/:sessionId` | Clear a session's memory |

Example:

```bash
curl -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Analyse GitHub user <username>","sessionId":"me"}'
```

The response contains the `answer` and the `steps` (tool calls the agent made). Sessions are kept in memory and reset when the server restarts.

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `GEMINI_API_KEY` | Gemini API key (required) | - |
| `GEMINI_MODEL` | Comma-separated list of models, tried in order | `gemini-2.5-flash,gemini-2.5-flash-lite` |
| `GITHUB_TOKEN` | GitHub token (optional) | - |
| `PORT` | API server port | `5000` |

To see which models your key can use:

```bash
node agent.js --models
```

## Troubleshooting

- **503 "high demand"** - Google's servers are busy. The agent retries automatically.
- **429 quota exceeded** - the free tier has a daily request limit per model. The agent switches to the next model in `GEMINI_MODEL`. If all are used up, wait for the reset, set another model, or use a key from a new project.
- **GitHub rate limit reached** - set `GITHUB_TOKEN`, or wait an hour.
- **Repo not found** - the repo may be private or renamed. The agent reports the error and continues with the other repos.

## Limitations

- Only reads public GitHub data.
- Generated resume points should be checked against your real projects before you use them.
- Session memory is in-process only (no database).
- Free-tier Gemini limits apply.

## License

MIT
