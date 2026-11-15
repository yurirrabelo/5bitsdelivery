package delivery.commons;

import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import java.util.HashMap;
import java.util.Map;

/** traceparent (W3C) do trace ativo, e o caminho de volta. Funciona com ou sem o agente. */
public final class Trace {
    private static final W3CTraceContextPropagator W3C = W3CTraceContextPropagator.getInstance();

    private Trace() {}

    /** traceparent do trace ativo, ou null se não houver trace. */
    public static String traceparentAtual() {
        Map<String, String> carrier = new HashMap<>();
        W3C.inject(Context.current(), carrier, Map::put);
        return carrier.get("traceparent");
    }

    /** Contexto OpenTelemetry reconstruído a partir de um traceparent guardado. */
    public static Context contextoDe(String traceparent) {
        if (traceparent == null) return Context.root();
        Map<String, String> carrier = Map.of("traceparent", traceparent);
        return W3C.extract(Context.root(), carrier, new TextMapGetter<Map<String, String>>() {
            @Override
            public Iterable<String> keys(Map<String, String> c) {
                return c.keySet();
            }

            @Override
            public String get(Map<String, String> c, String chave) {
                return c == null ? null : c.get(chave);
            }
        });
    }
}
