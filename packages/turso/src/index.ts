import { createClient, type Client, type InStatement } from "@libsql/client/web";
import { domainEventSchema, type DomainEvent } from "@relay/contracts";

export type TursoConfig = {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
};

export function createTursoClient(config: TursoConfig): Client {
  return createClient({
    url: config.TURSO_DATABASE_URL,
    authToken: config.TURSO_AUTH_TOKEN
  });
}

export function outboxInsert(event: DomainEvent): InStatement {
  return {
    sql: `
      INSERT INTO outbox_events (
        event_id, event_type, aggregate_id, aggregate_version,
        community_id, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      event.eventId,
      event.eventType,
      event.aggregateId,
      event.aggregateVersion,
      event.communityId,
      JSON.stringify(event),
      Date.parse(event.occurredAt)
    ]
  };
}

export async function publishPendingOutbox(
  config: TursoConfig,
  publish: (event: DomainEvent) => Promise<unknown>,
  limit = 50
): Promise<number> {
  const client = createTursoClient(config);
  try {
    const pending = await client.execute({
      sql: `
        SELECT event_id, payload_json
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY occurred_at
        LIMIT ?
      `,
      args: [limit]
    });

    let published = 0;
    for (const row of pending.rows) {
      const eventId = expectString(row.event_id, "event_id");
      const event = domainEventSchema.parse(parseJsonColumn(row.payload_json, "payload_json"));
      try {
        await publish(event);
        await client.execute({
          sql: `
            UPDATE outbox_events
            SET published_at = ?, publish_attempts = publish_attempts + 1, last_error = NULL
            WHERE event_id = ? AND published_at IS NULL
          `,
          args: [Date.now(), eventId]
        });
        published += 1;
      } catch (error) {
        await client.execute({
          sql: `
            UPDATE outbox_events
            SET publish_attempts = publish_attempts + 1, last_error = ?
            WHERE event_id = ? AND published_at IS NULL
          `,
          args: [safeError(error), eventId]
        });
        throw error;
      }
    }
    return published;
  } finally {
    client.close();
  }
}

export async function recordOutboxFailure(
  config: TursoConfig,
  eventId: string,
  error: unknown
): Promise<void> {
  const client = createTursoClient(config);
  try {
    await client.execute({
      sql: `
        UPDATE outbox_events
        SET publish_attempts = publish_attempts + 1, last_error = ?
        WHERE event_id = ? AND published_at IS NULL
      `,
      args: [safeError(error), eventId]
    });
  } finally {
    client.close();
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown outbox error";
  return message.slice(0, 500);
}

export function expectString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${column} to be a string`);
  }
  return value;
}

export function expectNumber(value: unknown, column: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`Expected ${column} to be a number`);
}

export function parseJsonColumn(value: unknown, column: string): unknown {
  return JSON.parse(expectString(value, column)) as unknown;
}
