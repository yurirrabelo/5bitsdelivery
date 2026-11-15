import { defineConfig } from 'vitest/config';

// os testes usam o Postgres compartilhado: um arquivo por vez
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30000, fileParallelism: false } });
