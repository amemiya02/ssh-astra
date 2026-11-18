#!/bin/bash
# Fills the demo user's home with a small, fictional web service project (and
# its git history) for the README screenshots to show. Runs once, at image
# build time, as the demo user. Everything here is made up.
set -euo pipefail
cd "$HOME"

mkdir -p app releases backups
cd app
git init --quiet --initial-branch=main
git config user.name "Demo Developer"
git config user.email "dev@example.com"

day=0
commit() {
  day=$((day + 1))
  local date
  date="2026-10-$(printf '%02d' "$day")T10:00:00Z"
  git add --all
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" git commit --quiet --message "$1"
}
merge() {
  day=$((day + 1))
  local date
  date="2026-10-$(printf '%02d' "$day")T10:00:00Z"
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" git merge --quiet --no-ff --no-edit "$1"
}

cat > README.md <<'EOF'
# orbit-api

The HTTP API behind Orbit: accounts, projects and billing webhooks.

    pnpm install
    pnpm dev
EOF
cat > package.json <<'EOF'
{
  "name": "orbit-api",
  "version": "2.4.0",
  "private": true,
  "scripts": { "dev": "tsx watch src/server.ts", "build": "tsc", "start": "node dist/server.js" }
}
EOF
printf 'node_modules/\ndist/\n.env\n' > .gitignore
printf 'MIT License\n\nCopyright (c) 2026 Orbit\n' > LICENSE
commit "Initial commit"

mkdir -p src/routes
printf 'import express from "express";\n\nconst app = express();\napp.get("/healthz", (_req, res) => res.send("ok"));\napp.listen(8080);\n' > src/server.ts
printf '{\n  "compilerOptions": { "target": "ES2022", "module": "NodeNext", "outDir": "dist", "strict": true }\n}\n' > tsconfig.json
commit "Add Express server and health check"

mkdir -p src/db migrations
printf 'import pg from "pg";\n\nexport const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });\n' > src/db/pool.ts
printf 'CREATE TABLE accounts (id uuid PRIMARY KEY, email text NOT NULL UNIQUE);\n' > migrations/001_accounts.sql
commit "Add Postgres connection pool"
GIT_COMMITTER_DATE="2026-10-03T12:00:00Z" git tag v2.3.0

git switch --quiet --create feature/rate-limit
mkdir -p src/middleware
printf 'export function tokenBucket(rate: number) {\n  return (_req: unknown, _res: unknown, next: () => void) => next();\n}\n' > src/middleware/rate-limit.ts
commit "Add token bucket rate limiter"
printf 'export { tokenBucket } from "./middleware/rate-limit";\n' > src/routes/index.ts
commit "Rate limit /api/* routes"

git switch --quiet main
printf 'CREATE TABLE projects (id uuid PRIMARY KEY, account_id uuid REFERENCES accounts);\n' > migrations/002_projects.sql
commit "Add projects table"
merge feature/rate-limit

git switch --quiet --create fix/healthcheck
printf 'import express from "express";\n\nconst app = express();\nlet ready = false;\napp.get("/healthz", (_req, res) => res.status(ready ? 200 : 503).send(ready ? "ok" : "migrating"));\napp.listen(8080);\n' > src/server.ts
commit "Return 503 while migrations run"

git switch --quiet main
printf 'export const log = (msg: string) => console.log(JSON.stringify({ ts: Date.now(), msg }));\n' > src/log.ts
commit "Add structured request logging"
merge fix/healthcheck

mkdir -p deploy scripts public
printf 'FROM node:22-alpine\nWORKDIR /srv\nCOPY dist ./dist\nCMD ["node", "dist/server.js"]\n' > Dockerfile
printf 'services:\n  api:\n    build: .\n    ports: ["8080:8080"]\n  db:\n    image: postgres:17\n' > docker-compose.yml
printf '[Unit]\nDescription=orbit-api\n\n[Service]\nExecStart=/usr/bin/node /srv/orbit-api/dist/server.js\nRestart=always\n' > deploy/orbit-api.service
printf '#!/bin/sh\nset -e\npnpm build\nrsync -a dist/ /srv/orbit-api/dist/\nsystemctl restart orbit-api\n' > scripts/deploy.sh
chmod +x scripts/deploy.sh
printf '<!doctype html><title>Orbit</title>\n' > public/index.html
printf 'DATABASE_URL=postgres://orbit@localhost:5432/orbit\n' > .env.example
printf '# Changelog\n\n## 2.4.0\n\n- Rate limiting on /api/*\n- 503 from /healthz while migrations run\n' > CHANGELOG.md
commit "Release 2.4.0"
GIT_COMMITTER_DATE="2026-10-11T12:00:00Z" git tag v2.4.0

git switch --quiet --create feature/metrics
printf 'export const metrics = new Map<string, number>();\n' > src/metrics.ts
commit "Expose Prometheus metrics at /metrics"
printf 'export const buckets = [5, 10, 25, 50, 100, 250, 500];\n' > src/histogram.ts
commit "Add p95 latency histogram"

git switch --quiet main
printf '\n## Deploy\n\n    ./scripts/deploy.sh\n' >> README.md
commit "Document the deploy steps"

# A few files for the File panel to list next to the project.
cd "$HOME"
head -c 2400000 /dev/urandom > backups/orbit-db-2026-11-16.sql.gz
head -c 2500000 /dev/urandom > backups/orbit-db-2026-11-17.sql.gz
head -c 18000000 /dev/urandom > releases/orbit-api-2.3.0.tar.gz
