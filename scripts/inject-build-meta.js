const fs = require("fs");
const path = require("path");

const sha =
  (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "dev").slice(0, 7);
const builtAt = new Date().toISOString();
const targetPath = path.join("public", "__build.json");

fs.writeFileSync(targetPath, JSON.stringify({ sha, builtAt }));
