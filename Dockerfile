FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server.js solver.js numbers.js result-check.js budget.js app.js index.html style.css ./
USER 10000:10000
ENV HOST=0.0.0.0 BUDGET_DB=/data/budget.sqlite
EXPOSE 3217
CMD ["bun", "server.js"]
