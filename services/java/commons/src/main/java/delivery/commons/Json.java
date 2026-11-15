package delivery.commons;

import tools.jackson.databind.json.JsonMapper;

/** Mapper das mensagens (Jackson 3). Records são suportados direto. */
public final class Json {
    public static final JsonMapper MAPPER = JsonMapper.builder().build();

    private Json() {}
}
