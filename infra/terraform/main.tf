terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    rabbitmq = {
      source  = "cyrilgdn/rabbitmq"
      version = "~> 1.8"
    }
  }
}

# AWS emulada pelo MiniStack: o mesmo código funciona numa AWS de verdade
provider "aws" {
  region                      = var.aws_region
  access_key                  = var.aws_access_key_id
  secret_key                  = var.aws_secret_access_key
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  endpoints {
    s3             = var.aws_endpoint_url
    secretsmanager = var.aws_endpoint_url
  }
}

provider "rabbitmq" {
  endpoint = var.rabbitmq_api_url
  username = var.rabbitmq_usuario
  password = var.rabbitmq_senha
}

# ---------------------------------------------------------------- Segredos

locals {
  bancos = {
    pedidos   = var.db_senha_pedidos
    estoque   = var.db_senha_estoque
    pagamento = var.db_senha_pagamento
    entregas  = var.db_senha_entregas
  }
}

resource "aws_secretsmanager_secret" "db" {
  for_each                = local.bancos
  name                    = "delivery/db/${each.key}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  for_each  = local.bancos
  secret_id = aws_secretsmanager_secret.db[each.key].id
  secret_string = jsonencode({
    host     = "pg-${each.key}"
    port     = 5432
    dbname   = each.key
    username = each.key
    password = each.value
  })
}

resource "aws_secretsmanager_secret" "rabbitmq" {
  name                    = "delivery/rabbitmq"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "rabbitmq" {
  secret_id = aws_secretsmanager_secret.rabbitmq.id
  secret_string = jsonencode({
    url = "amqp://${var.rabbitmq_usuario}:${var.rabbitmq_senha}@rabbitmq:5672"
  })
}

resource "aws_secretsmanager_secret" "jwt" {
  name                    = "delivery/jwt"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = jsonencode({ segredo = var.jwt_segredo })
}

resource "aws_secretsmanager_secret" "telegram" {
  name                    = "delivery/telegram"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "telegram" {
  secret_id     = aws_secretsmanager_secret.telegram.id
  secret_string = jsonencode({ botToken = var.telegram_bot_token })
}

# ---------------------------------------------------------------- S3

resource "aws_s3_bucket" "rotas" {
  bucket        = var.s3_bucket_rotas
  force_destroy = true
}

# ---------------------------------------------------------------- RabbitMQ

resource "rabbitmq_exchange" "eventos" {
  name  = var.rabbitmq_exchange
  vhost = "/"
  settings {
    type        = "topic"
    durable     = true
    auto_delete = false
  }
}

resource "rabbitmq_exchange" "dlx" {
  name  = var.rabbitmq_dlx
  vhost = "/"
  settings {
    type        = "direct"
    durable     = true
    auto_delete = false
  }
}

locals {
  # fila => tipos de mensagem ligados a ela (seção 4.3 da especificação)
  filas = {
    (var.fila_pedidos) = [
      "estoque.reservado", "estoque.esgotado", "pagamento.aprovado", "pagamento.recusado",
      "pagamento.estornado", "entrega.atribuida", "entrega.concluida",
    ]
    (var.fila_estoque)   = ["estoque.reservar", "pedido.confirmado", "pedido.cancelado"]
    (var.fila_pagamento) = ["pagamento.cobrar", "pagamento.estornar"]
    (var.fila_entregas)  = ["pedido.confirmado"]
  }

  bindings = merge([
    for fila, tipos in local.filas : {
      for tipo in tipos : "${fila}|${tipo}" => { fila = fila, tipo = tipo }
    }
  ]...)
}

# Filas quorum: contam as entregas e mandam para a DLQ ao passar de x-delivery-limit
resource "rabbitmq_queue" "fila" {
  for_each = local.filas
  name     = each.key
  vhost    = "/"
  settings {
    durable     = true
    auto_delete = false
    arguments_json = jsonencode({
      "x-queue-type"              = "quorum"
      "x-dead-letter-exchange"    = var.rabbitmq_dlx
      "x-dead-letter-routing-key" = each.key
      "x-delivery-limit"          = var.max_tentativas - 1
    })
  }
  depends_on = [rabbitmq_exchange.dlx]
}

resource "rabbitmq_queue" "dlq" {
  for_each = local.filas
  name     = "${each.key}.dlq"
  vhost    = "/"
  settings {
    durable     = true
    auto_delete = false
    arguments_json = jsonencode({
      "x-queue-type" = "quorum"
    })
  }
}

resource "rabbitmq_binding" "entrada" {
  for_each         = local.bindings
  source           = rabbitmq_exchange.eventos.name
  vhost            = "/"
  destination      = rabbitmq_queue.fila[each.value.fila].name
  destination_type = "queue"
  routing_key      = each.value.tipo
}

resource "rabbitmq_binding" "dlq" {
  for_each         = local.filas
  source           = rabbitmq_exchange.dlx.name
  vhost            = "/"
  destination      = rabbitmq_queue.dlq[each.key].name
  destination_type = "queue"
  routing_key      = each.key
}
