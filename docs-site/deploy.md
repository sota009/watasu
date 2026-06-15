# Deploy the docs site

This page is for the product owner setting up the public docs site.

## Recommended target

Use Cloudflare Pages for the first docs deployment.

Why:

- static site hosting is enough
- free tier is enough to start
- custom domain support fits `docs.watasu.ai`
- build output is just static files
- no database or runtime secrets are required

## Build settings

Use these settings in Cloudflare Pages:

| Setting | Value |
| --- | --- |
| Project name | `watasu-docs` |
| Production branch | `main` |
| Build command | `pnpm install --frozen-lockfile && pnpm docs:build` |
| Build output directory | `doc_build` |
| Node.js version | `22` or newer |
| Custom domain | `docs.watasu.ai` |

## Local verification

```bash
pnpm docs:build
pnpm docs:preview
```

After build, check these files exist:

```text
doc_build/index.html
doc_build/llms.txt
doc_build/llms-full.txt
```

## Owner checklist

```text
[ ] Create a Cloudflare Pages project connected to the GitHub repo.
[ ] Set build command to `pnpm install --frozen-lockfile && pnpm docs:build`.
[ ] Set output directory to `doc_build`.
[ ] Add custom domain `docs.watasu.ai`.
[ ] Verify DNS and TLS in Cloudflare.
[ ] Open `/llms.txt` and `/llms-full.txt` after deploy.
[ ] Add the public docs URL to product-facing materials.
```

No production watasu secrets are required for the docs site.
