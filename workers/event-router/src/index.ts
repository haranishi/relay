import { domainEventSchema, type DomainEvent } from "@relay/contracts";

export default {
  async queue(batch: MessageBatch<DomainEvent>, env: Env) {
    for (const message of batch.messages) {
      try {
        const event = domainEventSchema.parse(message.body);
        await Promise.all([
          env.LISTING_COMMANDS.send(event),
          env.MATCHING_COMMANDS.send(event),
          env.READ_MODEL_COMMANDS.send(event),
          env.NOTIFICATION_COMMANDS.send(event)
        ]);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({ service: "event-router", messageId: message.id, error: String(error) })
        );
        message.retry({ delaySeconds: 10 });
      }
    }
  }
} satisfies ExportedHandler<Env, DomainEvent>;
