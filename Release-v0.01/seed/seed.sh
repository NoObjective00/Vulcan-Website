#!/usr/bin/env bash
# Seed Cloudflare KV with the site's starting content.
# Run from the repo root:  bash seed/seed.sh
set -e
NS=910c53d8c1294b36bcb3839ef773a165
for k in brand copy jugs hero stats fixtures music week announcements offers highlights hours drinks theme settings; do
  echo "→ $k"
  npx wrangler kv key put "$k" --namespace-id="$NS" --path="seed/$k.json" --remote
done
echo "Done. Check /api/content."
