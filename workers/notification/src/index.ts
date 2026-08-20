import { domainEventSchema, type DomainEvent } from "@relay/contracts";

const notifiableEvents = new Set([
  "ApplicationSubmitted.v1",
  "RecipientSelected.v1",
  "RecipientReoffered.v1",
  "HandoffCancelled.v1",
  "HandoffCompleted.v1"
]);

export default {
  queue(batch: MessageBatch<DomainEvent>) {
    for (const message of batch.messages) {
      try {
        const event = domainEventSchema.parse(message.body);
        if (notifiableEvents.has(event.eventType)) {
          // MVPでは構造化ログを通知の境界にする。メール送信は同じConsumer内へ追加できる。
          console.log(JSON.stringify({ service: "notification", action: "notification_planned", eventId: event.eventId, eventType: event.eventType, communityId: event.communityId }));
        }
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ service: "notification", messageId: message.id, error: String(error) }));
        message.retry({ delaySeconds: 10 });
      }
    }
  }
} satisfies ExportedHandler<Env, DomainEvent>;
