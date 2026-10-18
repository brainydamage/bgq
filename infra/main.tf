# Синхронизация событий между телефонами: DynamoDB (одна таблица) + Lambda с Function URL.
# Перед apply: corepack pnpm --filter @bgq/sync build (→ build/handler.mjs).
# После apply: terraform -chdir=infra output -json sync > games/sync.json (→ ./bgq pwa).

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "bgq" }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "allowed_origins" {
  description = "Откуда PWA ходит в API: оболочка на GitHub Pages и ./bgq pwa dev|preview."
  type        = list(string)
  default     = ["https://brainydamage.github.io", "http://localhost:5174", "http://localhost:4174"]
}

variable "reserved_concurrency" {
  description = "Потолок одновременных вызовов (затраты при утечке кода). -1 — без потолка: на новых аккаунтах AWS не даёт резервировать при лимите 10."
  type        = number
  default     = 5
}

# Общий код команды: в окружении Lambda и в phone.json. Сменить: terraform apply -replace=random_password.code
resource "random_password" "code" {
  length  = 32
  special = false
}

# pk = game#<gameId>, sk = ev#<id события> (conditional write — идемпотентность),
# byRecv: r = <время прихода>#<id> — чтение «после курсора».
resource "aws_dynamodb_table" "events" {
  name                        = "bgq-events"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "r"
    type = "S"
  }

  local_secondary_index {
    name            = "byRecv"
    range_key       = "r"
    projection_type = "ALL"
  }

  # Ответы игры — главное, что храним: восстановление на любой момент за 35 дней.
  point_in_time_recovery {
    enabled = true
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/build/handler.mjs"
  output_path = "${path.module}/build/lambda.zip"
}

resource "aws_iam_role" "lambda" {
  name = "bgq-sync"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "dynamodb" {
  name = "events"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem", "dynamodb:Query"]
      Resource = [aws_dynamodb_table.events.arn, "${aws_dynamodb_table.events.arn}/index/*"]
    }]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/bgq-sync"
  retention_in_days = 14
}

resource "aws_lambda_function" "sync" {
  function_name                  = "bgq-sync"
  role                           = aws_iam_role.lambda.arn
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  handler                        = "handler.handler"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  memory_size                    = 256
  timeout                        = 10
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      TABLE     = aws_dynamodb_table.events.name
      SYNC_CODE = random_password.code.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy_attachment.logs]
}

# Доступ без подписи AWS: код проверяет сама функция (x-bgq-code). CORS (в т.ч. preflight) — здесь.
resource "aws_lambda_function_url" "sync" {
  function_name      = aws_lambda_function.sync.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = var.allowed_origins
    allow_methods = ["POST"]
    allow_headers = ["content-type", "x-bgq-code"]
    max_age       = 86400
  }
}

# Публичный Function URL требует обоих разрешений: InvokeFunctionUrl и InvokeFunction через URL.
resource "aws_lambda_permission" "url" {
  statement_id           = "FunctionUrlPublic"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.sync.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "invoke" {
  statement_id             = "FunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.sync.function_name
  principal                = "*"
  invoked_via_function_url = true
}

output "url" {
  value = aws_lambda_function_url.sync.function_url
}

# Для games/sync.json: terraform -chdir=infra output -json sync > games/sync.json
output "sync" {
  value = {
    url  = aws_lambda_function_url.sync.function_url
    code = random_password.code.result
  }
  sensitive = true
}
