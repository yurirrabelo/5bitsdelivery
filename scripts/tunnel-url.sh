#!/usr/bin/env bash
# Mostra a URL pública do túnel Cloudflare (a URL muda a cada reinício do cloudflared).
# Uso: ./scripts/tunnel-url.sh [url-a-ignorar]
# O contêiner guarda no log as URLs das execuções anteriores. Depois de religar o túnel, quem chama passa a URL velha
# para ela não ser devolvida no lugar da nova (o ./demo.sh link faz isso).
set -euo pipefail
cd "$(dirname "$0")/.."
ignorar="${1:-}"
for _ in $(seq 1 30); do
  url=$(docker compose logs cloudflared 2>/dev/null | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  if [ -n "$url" ] && [ "$url" != "$ignorar" ]; then echo "$url"; exit 0; fi
  sleep 2
done
echo "URL do túnel não encontrada. Suba com: docker compose --profile tunnel up -d" >&2
exit 1
