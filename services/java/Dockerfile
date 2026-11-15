# Um Dockerfile para os serviços Java (pedidos, estoque). Contexto de build: a raiz do repositório.
#   docker build -f services/java/Dockerfile --build-arg SERVICO=pedidos .
FROM maven:3.9-eclipse-temurin-21 AS build
ARG SERVICO
WORKDIR /app
COPY services/java/ ./
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp -q -pl ${SERVICO} -am package -DskipTests

FROM eclipse-temurin:21-jre-alpine
ARG SERVICO
# Agente OpenTelemetry: traces, métricas e logs sem mudar o código
ADD https://repo1.maven.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/2.33.1/opentelemetry-javaagent-2.33.1.jar /opt/otel/agente.jar
WORKDIR /app
COPY --from=build /app/${SERVICO}/target/${SERVICO}.jar app.jar
COPY contracts /app/contracts
ENV CONTRACTS_DIR=/app/contracts \
    JAVA_TOOL_OPTIONS="-javaagent:/opt/otel/agente.jar -XX:MaxRAMPercentage=60 -XX:+UseSerialGC" \
    OTEL_METRIC_EXPORT_INTERVAL=10000
RUN adduser -D app && chmod 644 /opt/otel/agente.jar
USER app
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
