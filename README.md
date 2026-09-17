# Jev Calculator

An iOS 6-inspired calculator experiment using `typesafe-ai/jev` through Vercel AI Gateway. Bun serves the static UI and streams evaluation steps from the server. The API key stays on the server.

Live: **https://jev-calculator.vercel.app**. The free Vercel Hobby project only forwards requests to Oracle through a project-level routing rule; no API keys or application code are deployed there. Inspect it with `vercel routes list --project jev-calculator --scope sstehniys-projects`.

The published rule is named `Oracle calculator`, matches `^/(.*)$`, and rewrites to `https://oracle.tail92806c.ts.net/$1`. Routing changes use `vercel routes publish --yes --project jev-calculator --scope sstehniys-projects`; ordinary app updates only require redeploying Oracle.

## Run

```sh
bun install
# Set AI_GATEWAY_API_KEY in .env
mkdir -p data
bun budget.js init data/budget.sqlite
bun start
```

Open http://127.0.0.1:3217. Run `bun test` for the narrowing and accounting checks.

## How it works

Jev chooses the magnitude, sign, and each decimal digit in one parallel request. Code combines the probability distributions into likely candidate numbers without evaluating the expression. Jev then chooses among up to 48 candidates. Rejected candidates trigger a wider set; uncertain answers get a focused recheck. Small answers normally take two gateway calls. Larger magnitudes expand automatically, with extra digits read in batches. Each call appears as one expandable step containing all its questions.

Integer precision is the default; select 2 or 4 decimal places for fractions. There is no fixed answer-size cutoff. Candidate digits use BigInt and decimal strings to preserve large integers, including values beyond JavaScript’s safe integer range. A separate math.js check reveals the real answer after Jev finishes, with a green match or red miss badge at the selected decimal precision. It never supplies the answer to Jev or affects its choices. Arithmetic quality is part of the experiment, not a guarantee. A low-probability result is shown as Jev's best guess.

The receipt shows all choices and probabilities, total gateway calls, question count, input tokens, elapsed time, and summed gateway-reported USD cost. Missing gateway cost is estimated at $0.042 per million input tokens. Failed requests can have unreported charges.

## Measurement

Run `bun benchmarks/run.js ../solver.js benchmarks/after.json` to repeat the 12-case workload with real gateway calls. `benchmarks/baseline.js` preserves the original solver for the same benchmark. These scripts use the configured key and incur API charges.

The measured bottleneck was sequential model requests, not local calculation or rendering. In the measured 12-case run, the original solver had a median 7 calls / 2.29 seconds and 8 correct results; the updated solver had a median 2 calls / 0.78 seconds and 12 correct results. Total cost fell from $0.001789536 to $0.00131124 (27%). These are small-sample observations, not general accuracy claims.

The reported `200*123` failure originally stopped after 7 calls / 2.48 seconds. The new solver returned 24600 in repeated two-call runs. Raw results are in `benchmarks/baseline.json`, `benchmarks/after.json`, and `benchmarks/reported-after.json`.

The production image bundles the isolated reference checker. On Oracle, three identical checks had a median 1.286 seconds unbundled versus 0.198 seconds bundled, including Docker exec overhead. This keeps the process timeout without paying for hundreds of module imports on each run.

Relevant official guidance: [batch independent questions](https://docs.typesafe.ai/patterns/fan-out), [retain alternative paths](https://docs.typesafe.ai/cookbooks/hierarchical_classification), and [known arithmetic limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Lifetime budget

Create a dedicated key with Vercel CLI:

```sh
vercel ai-gateway api-keys create --name jev-calculator-oracle --budget 1 --refresh-period none --include-byok --scope YOUR_TEAM
```

Vercel applies this $1 cumulative budget to all usage of the key, across every app and model. It never resets. [Vercel documents this as a soft cap](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets): in-flight requests can overshoot. Do not reuse this deployment key elsewhere.

The app adds a durable pre-request check for its exclusive key. Each request reserves $0.01 atomically before contacting the gateway, then refunds the unused amount from the actual reported cost. Missing cost, crashes, cancellations, and network errors keep the reservation. At the current Jev price ($0.042/M input tokens, no output charge), this comfortably covers the maximum 64 KB request. There are no SDK retries or alternative models. The app stops when less than one reservation remains. Tests cover concurrency, restart persistence, missing costs, and exhausted budgets. Unexpected pricing locks the ledger; this cannot promise protection against unannounced provider billing changes or use of the key outside the app.

Keep the ledger for the lifetime of the key. Never delete, reset, or restore an older ledger while that key is active. A missing or corrupt ledger prevents the server from starting. Initialization refuses to overwrite an existing file.

## Oracle deployment

The public URL is served by Tailscale Funnel with managed HTTPS. The container port is bound to localhost only; SSH remains reachable through the private tailnet. The app runs as a non-root user in a read-only container with dropped capabilities, no privilege escalation, bounded CPU/memory/processes, and rotating logs. Only the budget directory is writable. No Docker socket is mounted. Requests have a 1 KB body limit, two concurrent calculations, 30 starts per minute, and a three-minute gateway timeout. Reference arithmetic runs in a separate process with a 1.5-second timeout. Responses use restrictive security headers and reject cross-site browser submissions.

Server paths:

- `/opt/jev-calculator`: deployment source and Dockerfile
- `/etc/jev-calculator.env`: root-only API key, `HOST=0.0.0.0`, `BUDGET_DB=/data/budget.sqlite`, and `PUBLIC_ORIGIN`
- `/var/lib/jev-calculator/budget.sqlite`: lifetime ledger, owned by UID 10000
- `/etc/systemd/system/jev-calculator.service`: restarts the container after failures and reboots

`PUBLIC_ORIGIN` contains the exact allowed browser origins, separated by commas: `https://jev-calculator.vercel.app,https://oracle.tail92806c.ts.net`.

First deployment: create the root-only environment file, install the service from this repo, build the image, and initialize the ledger exactly once with the same image:

```sh
sudo install -d -o 10000 -g 10000 -m 700 /var/lib/jev-calculator
docker build -t jev-calculator:latest /opt/jev-calculator
docker run --rm --user 10000:10000 -v /var/lib/jev-calculator:/data jev-calculator:latest bun budget.js init /data/budget.sqlite
sudo systemctl daemon-reload
sudo systemctl enable --now jev-calculator
sudo tailscale funnel --bg --https=443 http://127.0.0.1:3217
```

To update, transfer a reviewed Git archive to `/opt/jev-calculator`, rebuild the image, and `sudo systemctl restart jev-calculator`. Preserve the environment file and budget directory. Check `sudo systemctl status jev-calculator` and `sudo tailscale funnel status`. To unpublish, use `sudo tailscale funnel --https=443 off`. No Cloudflare tunnel or local laptop process is needed.

Sources: https://vercel.com/docs/ai-gateway/modalities/evaluation and https://vercel.com/ai-gateway/models/jev
