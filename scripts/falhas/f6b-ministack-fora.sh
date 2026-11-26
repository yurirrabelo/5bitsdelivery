#!/usr/bin/env bash
# Variante do F6 com o MiniStack: ele para durante uma entrega. Os serviços seguem (os segredos já foram lidos),
# a exportação da rota para o S3 fica pendente e é feita quando ele volta. Segredos e bucket continuam lá
# (PERSIST_STATE=1).
source "$(dirname "$0")/lib.sh"
trap 'docker compose start ministack >/dev/null 2>&1; restaurar; ./scripts/limpar-gps.sh' EXIT   # o simulador deixa um GPS falso no mapa

titulo "F6b - MiniStack fora" "S3 indisponível na hora de exportar a rota: fica pendente e sai quando ele volta"
login_operador
limpar_entregas_de_teste
repor_estoque
# último ponto de simulador/rotas/exemplo.geojson
LAT=-26.9148; LON=-49.0610

esperar_ate "[ \"\$(sql entregas \"SELECT status FROM entregadores WHERE id = 2\")\" = DISPONIVEL ]" 30
verificar "entregador 2 disponível" DISPONIVEL "$(sql entregas "SELECT status FROM entregadores WHERE id = 2")"

echo "Passo 1: para o MiniStack"
docker compose stop ministack >/dev/null 2>&1

echo "Passo 2: cria o pedido, o entregador 2 aceita (o sistema segue funcionando sem o MiniStack)"
r=$(api POST /api/pedidos "{\"destino\":{\"lat\":$LAT,\"lon\":$LON,\"endereco\":\"Fim da rota de exemplo\"},\"entregadorPreferidoId\":2}")
id=$(campo "$r" id)
echo "         pedido #$id"
verificar "o entregador 2 aceitou o pedido" 200 "$(aceitar_entrega 2 "$id")"
esperar_status "$id" EM_ENTREGA 60
verificar "pedido em entrega com o MiniStack fora" EM_ENTREGA "$(status_pedido "$id")"

echo "Passo 3: o simulador percorre a rota de exemplo até o destino"
docker compose --profile sim run --rm --build simulador rota --arquivo /rotas/exemplo.geojson --entregador 2 --velocidade 150 --intervalo 1 2>&1 | tail -2
esperar_status "$id" ENTREGUE 30
verificar "pedido ENTREGUE" ENTREGUE "$(status_pedido "$id")"
sleep 14   # passa pelo menos um ciclo do laço de exportação (10 s)
verificar "rota exportada com o S3 fora (deve estar pendente)" f "$(sql entregas "SELECT rota_exportada FROM entregas WHERE pedido_id = $id")"

echo "Passo 4: o MiniStack volta; a exportação pendente é feita"
docker compose start ministack >/dev/null 2>&1
esperar_saudavel ministack 60
esperar_ate "[ \"\$(sql entregas \"SELECT rota_exportada FROM entregas WHERE pedido_id = $id\")\" = t ]" 60

echo
echo "Resultado:"
verificar "rota exportada depois que o MiniStack voltou" t "$(sql entregas "SELECT rota_exportada FROM entregas WHERE pedido_id = $id")"
verificar "arquivo no S3 (GET rotas/pedido-$id.geojson)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4566/$(var S3_BUCKET_ROTAS)/rotas/pedido-$id.geojson")"
segredos=$(curl -s -X POST http://127.0.0.1:4566/ -H 'Content-Type: application/x-amz-json-1.1' -H 'X-Amz-Target: secretsmanager.ListSecrets' \
  -H "Authorization: AWS4-HMAC-SHA256 Credential=$(var AWS_ACCESS_KEY_ID)/20260101/$(var AWS_REGION)/secretsmanager/aws4_request, SignedHeaders=host, Signature=x" -d '{}' | grep -o '"Name"' | wc -l | tr -d ' ')
verificar "segredos continuam lá (PERSIST_STATE=1)" 6 "$segredos"

finalizar F6b "as linhas \"arquivo no S3\" e \"segredos continuam lá\" acima: a rota saiu quando o MiniStack voltou e os segredos não se perderam. Grafana, no fim da tela: o registro mostra \"exportação da rota pendente\" e depois \"rota exportada para o S3\". O arquivo da rota abre em http://localhost:4566/$(var S3_BUCKET_ROTAS)/rotas/pedido-$id.geojson"
