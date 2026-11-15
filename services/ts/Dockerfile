# Um Dockerfile para todos os serviços TypeScript. Contexto de build: a raiz do repositório.
#   docker build -f services/ts/Dockerfile --build-arg SERVICO=auth .
FROM node:24-alpine AS build
WORKDIR /app
COPY services/ts/ ./
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
ARG SERVICO
ENV SERVICO=${SERVICO} NODE_ENV=production CONTRACTS_DIR=/app/contracts
WORKDIR /app
COPY --from=build /app ./
COPY contracts ./contracts
USER node
EXPOSE 3000
# registro.js liga a telemetria OpenTelemetry antes do código do serviço
CMD ["sh", "-c", "exec node --require @delivery/commons/registro ${SERVICO}/dist/main.js"]
