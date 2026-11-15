# Prompt para o Claude Code

**Antes de colar:** crie a pasta do repositório e copie para ela o `README.md` e a pasta `docs/` (com `ESPECIFICACAO.md`, `REGISTRO_TEMA.md` e `arquitetura/`). Abra o Claude Code nessa pasta e cole o texto abaixo da linha. Este arquivo não precisa ir para o repositório.

---

Você vai implementar o "5Bits Delivery", trabalho final da disciplina de Sistemas Distribuídos. A apresentação é em 26/11, com demonstração ao vivo e falhas provocadas na frente do professor. A prioridade é: simples, estável e fácil de explicar.

## Fonte da verdade

- `docs/ESPECIFICACAO.md` define arquitetura, contratos, padrões de confiabilidade, segurança, infraestrutura, observabilidade, testes do professor e a ordem das fases. Leia inteiro antes de começar.
- `README.md` é o manual de execução. Mantenha-o fiel ao que você implementar: comandos, portas e variáveis.
- `docs/arquitetura/` tem os diagramas. Se a arquitetura mudar, avise para atualizarmos os desenhos.
- Se encontrar inconsistência ou lacuna na especificação, aponte e proponha a correção antes de implementar. Não invente regra de negócio.

## Como trabalhar

1. Implemente uma fase por vez, na ordem da seção 13 da especificação.
2. No início de cada fase, mostre um plano curto (arquivos que vai criar ou alterar e decisões relevantes) e espere meu ok.
3. No fim de cada fase, rode a verificação "Pronto quando", mostre o resultado e faça um commit com mensagem clara, por exemplo `fase 4: pedidos e estoque com reserva condicional`.
4. Não comece a fase seguinte sem meu ok.

## Regras

- Duas linguagens: Java 21 com Spring Boot (pedidos e estoque) e TypeScript com Node.js e Fastify (auth, pagamento, gateway-pagamento, entregas, simulador e, no bônus, consultas). Nada de terceira linguagem nos serviços.
- Não adicione serviços, bancos, frameworks ou bibliotecas pesadas fora da especificação sem perguntar.
- Código simples e idiomático. Nada de camadas e abstrações desnecessárias; prefira poucos arquivos bem nomeados. Termos de domínio em português, como no documento.
- Use exatamente os nomes de mensagens, filas, exchanges, segredos, rotas e variáveis da especificação.
- Endpoints, credenciais e nomes de filas e exchanges vêm de variáveis de ambiente ou do Secrets Manager, nunca fixos no código (exigência do enunciado).
- Todo envelope de mensagem tem `messageId`, `correlationId`, `type`, `version`, `occurredAt` e `payload`, validado contra `contracts/`.
- Os padrões da seção 5 são o centro da nota e ficam na biblioteca `commons` de cada linguagem: outbox com `traceparent`, inbox na mesma transação do efeito, erro de mensagem → DLQ após `MAX_TENTATIVAS`, erro de infraestrutura → segura a mensagem e tenta de novo, reconexão automática.
- Toda mudança de estado é um UPDATE condicional, como na especificação.
- Nenhum container publica porta além do que está na seção 7.1.
- Toda infraestrutura de nuvem e a topologia do RabbitMQ saem do Terraform (seção 7.2). Se o provider da AWS não funcionar com o MiniStack, avise antes de trocar por script.
- Nunca commite `.env` nem segredos. Mantenha o `.env.example` com valores de desenvolvimento que funcionem.
- Scripts `.sh` com final de linha LF e compatíveis com Linux, macOS e Git Bash ou WSL.
- Testes não podem exigir Java ou Node na máquina: rode tudo em containers (`scripts/test-all.sh`).
- Cada script de `scripts/falhas/` mostra o esperado e o obtido, termina com PASSOU ou FALHOU e devolve a configuração normal no final.
- No `/gps`, implemente os três formatos da seção 9.4 e logue o payload bruto em DEBUG.
- Telemetria só o necessário para mostrar o caminho de cada passo: auto-instrumentação, as métricas de negócio da seção 8 e logs com `correlationId`.
- Comentários curtos, em português e só onde ajudam.

## Ao terminar cada fase, me responda com

- O que foi feito, em poucas linhas.
- Como eu verifico, com os comandos exatos.
- Pendências ou riscos.

Comece pela Fase 1.
