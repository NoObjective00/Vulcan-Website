# Windows PowerShell version. Run from the repo root:  ./seed/seed.ps1
$NS = "910c53d8c1294b36bcb3839ef773a165"
$keys = @("brand", "copy", "jugs", "hero", "stats", "fixtures", "music", "week", "announcements", "offers", "highlights", "hours", "drinks", "theme", "settings")
foreach ($k in $keys) {
  Write-Host "-> $k"
  npx wrangler kv key put $k --namespace-id=$NS --path="seed/$k.json" --remote
}
Write-Host "Done. Check /api/content."
