// tools.js - the things the agent is allowed to do.
// Each tool has: a description (the AI reads this), parameters, and a run() function.

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(process.cwd(), "output");

// ---------- Helper: call the GitHub API ----------
async function github(apiPath, accept = "application/vnd.github+json") {
  const headers = { Accept: accept, "User-Agent": "github-career-agent" };
  // Optional token: raises the limit from 60 to 5000 requests per hour
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch("https://api.github.com" + apiPath, { headers });
  if (res.status === 404) throw new Error("Not found on GitHub: " + apiPath);
  if (res.status === 403 || res.status === 429) {
    const limited = res.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(
      limited
        ? "GitHub rate limit reached (60 requests per hour without a token). Wait a while, or set GITHUB_TOKEN."
        : "GitHub refused the request (" + res.status + ")."
    );
  }
  if (!res.ok) throw new Error("GitHub error " + res.status);
  return accept.includes("raw") ? res.text() : res.json();
}

const need = (value, name) => {
  if (!value || typeof value !== "string") throw new Error(`Missing required argument: ${name}`);
  return encodeURIComponent(value.trim());
};

// ---------- The tools ----------
const tools = {
  list_repos: {
    description:
      "List the public repositories (not forks) of a GitHub user, newest first. Returns name, description, main language, stars and last update date.",
    parameters: {
      type: "OBJECT",
      properties: { username: { type: "STRING", description: "GitHub username, e.g. parthivjp" } },
      required: ["username"],
    },
    run: async ({ username }) => {
      const repos = await github(`/users/${need(username, "username")}/repos?per_page=40&sort=updated`);
      return repos
        .filter((r) => !r.fork)
        .map((r) => ({
          name: r.name,
          description: r.description,
          language: r.language,
          stars: r.stargazers_count,
          updated: r.updated_at.slice(0, 10),
        }));
    },
  },

  get_readme: {
    description:
      "Read the README of one repository (cleaned, first 3500 characters). Use it to understand what a project does and which technologies it uses.",
    parameters: {
      type: "OBJECT",
      properties: {
        owner: { type: "STRING", description: "GitHub username that owns the repo" },
        repo: { type: "STRING", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
    run: async ({ owner, repo }) => {
      // The AI sometimes misspells a repo name, so match it against the real list first
      let realName = repo;
      try {
        const all = await github(`/users/${need(owner, "owner")}/repos?per_page=100`);
        const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
        const hit = all.find((r) => r.name === repo) || all.find((r) => norm(r.name) === norm(repo));
        if (hit) realName = hit.name;
      } catch {}
      const raw = await github(
        `/repos/${need(owner, "owner")}/${need(realName, "repo")}/readme`,
        "application/vnd.github.raw"
      );
      return raw
        .replace(/<[^>]+>/g, "") // remove HTML tags
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // remove image badges
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 3500);
    },
  },

  get_languages: {
    description: "Get the programming languages used in a repository, with bytes of code per language.",
    parameters: {
      type: "OBJECT",
      properties: {
        owner: { type: "STRING", description: "GitHub username that owns the repo" },
        repo: { type: "STRING", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
    run: ({ owner, repo }) =>
      github(`/repos/${need(owner, "owner")}/${need(repo, "repo")}/languages`),
  },

  write_file: {
    description:
      "Save text to a .md or .txt file inside the output folder. Use it for the final report. Returns the saved file path.",
    parameters: {
      type: "OBJECT",
      properties: {
        filename: { type: "STRING", description: "File name only, ending in .md or .txt, e.g. resume-points.md" },
        content: { type: "STRING", description: "The full text to save" },
      },
      required: ["filename", "content"],
    },
    run: ({ filename, content }) => {
      if (typeof filename !== "string" || typeof content !== "string") {
        throw new Error("filename and content must be text.");
      }
      // Safety: no folders, only .md or .txt
      if (filename !== path.basename(filename) || !/\.(md|txt)$/i.test(filename)) {
        throw new Error("Use a plain file name ending in .md or .txt");
      }
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const fullPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(fullPath, content, "utf8");
      return `Saved ${content.length} characters to ${fullPath}`;
    },
  },
};

// The list of tools in the format Gemini expects
const toolDeclarations = Object.entries(tools).map(([name, t]) => ({
  name,
  description: t.description,
  parameters: t.parameters,
}));

module.exports = { tools, toolDeclarations };
