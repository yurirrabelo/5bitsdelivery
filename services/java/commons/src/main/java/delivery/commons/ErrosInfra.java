package delivery.commons;

import java.net.ConnectException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLTransientConnectionException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.transaction.CannotCreateTransactionException;

/**
 * Erro de infraestrutura (banco fora do ar): a mensagem não tem culpa e não pode ir para a DLQ.
 * O consumidor segura a mensagem e tenta de novo.
 */
public final class ErrosInfra {
    private ErrosInfra() {}

    public static boolean ehInfra(Throwable erro) {
        for (Throwable t = erro, anterior = null; t != null && t != anterior; anterior = t, t = t.getCause()) {
            if (t instanceof CannotGetJdbcConnectionException
                    || t instanceof CannotCreateTransactionException
                    || t instanceof DataAccessResourceFailureException
                    || t instanceof TransientDataAccessException
                    || t instanceof QueryTimeoutException
                    || t instanceof SQLTransientConnectionException
                    || t instanceof SQLNonTransientConnectionException
                    || t instanceof ConnectException
                    || t instanceof SocketException
                    || t instanceof SocketTimeoutException
                    || t instanceof UnknownHostException) {
                return true;
            }
            if (t instanceof SQLException sql && sql.getSQLState() != null) {
                // classe 08 (falha de conexão), 53 (recursos) e 57P (banco desligando) do Postgres
                String estado = sql.getSQLState();
                if (estado.startsWith("08") || estado.startsWith("53") || estado.startsWith("57P")) return true;
            }
        }
        return false;
    }
}
