# boreas

Self-hosted URL shortener on Cloudflare Workers + KV. Serves `r.rushivivek.com/<slug>` → long URL.

## First-time setup

```bash
npm install

npx wrangler login
npx wrangler kv namespace create LINKS
# paste the printed `id` into wrangler.toml (replaces REPLACE_WITH_KV_ID)

npx wrangler secret put BOREAS_TOKEN
# paste a long random string when prompted; save it in your password manager

npx wrangler deploy
```

Then in the Cloudflare dashboard → **Workers & Pages → boreas → Settings → Domains & Routes → Add → Custom Domain** → `r.rushivivek.com`.

## Updating

After editing code:

```bash
npx wrangler deploy
```

KV data, the secret, and the custom domain stick around across deploys. Use `npx wrangler rollback` if a deploy goes bad.

## Managing links

```bash
TOKEN=...   # the BOREAS_TOKEN you set
BASE=https://r.rushivivek.com

# create
curl -X POST $BASE/_links \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"cv","url":"https://example.com/cv.pdf"}'

# list
curl $BASE/_links -H "Authorization: Bearer $TOKEN"

# update
curl -X PUT $BASE/_links/cv \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"cv","url":"https://example.com/cv-v2.pdf"}'

# delete
curl -X DELETE $BASE/_links/cv -H "Authorization: Bearer $TOKEN"
```

Rotate the admin token with `npx wrangler secret put BOREAS_TOKEN`.
