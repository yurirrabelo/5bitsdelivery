# Todos os valores chegam do .env como TF_VAR_*

variable "aws_endpoint_url" { type = string }
variable "aws_region" { type = string }
variable "aws_access_key_id" { type = string }
variable "aws_secret_access_key" {
  type      = string
  sensitive = true
}
variable "s3_bucket_rotas" { type = string }

variable "db_senha_pedidos" {
  type      = string
  sensitive = true
}
variable "db_senha_estoque" {
  type      = string
  sensitive = true
}
variable "db_senha_pagamento" {
  type      = string
  sensitive = true
}
variable "db_senha_entregas" {
  type      = string
  sensitive = true
}

variable "rabbitmq_api_url" { type = string }
variable "rabbitmq_usuario" { type = string }
variable "rabbitmq_senha" {
  type      = string
  sensitive = true
}
variable "rabbitmq_exchange" { type = string }
variable "rabbitmq_dlx" { type = string }
variable "fila_pedidos" { type = string }
variable "fila_estoque" { type = string }
variable "fila_pagamento" { type = string }
variable "fila_entregas" { type = string }
variable "max_tentativas" { type = number }

variable "jwt_segredo" {
  type      = string
  sensitive = true
}
variable "telegram_bot_token" {
  type      = string
  default   = ""
  sensitive = true
}
