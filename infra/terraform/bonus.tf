# Recursos dos BÔNUS (CQRS). Ficam num arquivo à parte para o núcleo do Terraform (main.tf) continuar enxuto.

# ---------------------------------------------------------------- DynamoDB (bônus CQRS)

# Modelo de leitura dos pedidos: leitura por chave, sem joins, separada da escrita (Postgres do pedidos).
# Uma tabela só: PEDIDO#<id> guarda a linha do tempo do pedido; MSG#<messageId> é a inbox do serviço consultas.
resource "aws_dynamodb_table" "visao" {
  name         = var.dynamodb_tabela_visao
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
}

# ---------------------------------------------------------------- Fila do CQRS (bônus)

# consultas.entrada recebe TODAS as mensagens (binding "#"). É limitada e sem DLX de propósito: se o serviço
# consultas não estiver no ar, a fila não cresce sem parar e nada vai parar numa DLQ. A visão é só leitura.
resource "rabbitmq_queue" "consultas" {
  name  = var.fila_consultas
  vhost = "/"
  settings {
    durable     = true
    auto_delete = false
    arguments_json = jsonencode({
      "x-queue-type"     = "quorum"
      "x-max-length"     = 2000
      "x-overflow"       = "drop-head"
      "x-delivery-limit" = var.max_tentativas - 1
    })
  }
}

resource "rabbitmq_binding" "consultas" {
  source           = rabbitmq_exchange.eventos.name
  vhost            = "/"
  destination      = rabbitmq_queue.consultas.name
  destination_type = "queue"
  routing_key      = "#"
}
