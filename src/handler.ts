import { APIGatewayProxyEventV2 } from "aws-lambda";
import { Client, validateSignature, WebhookEvent } from "@line/bot-sdk";

const client = new Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.CHANNEL_SECRET!,
})

export const webhook = async (event: APIGatewayProxyEventV2) => {
  const signature = event.headers['x-line-signature'];
  const body = event.body || "";

  // Validate signature
  if (!signature || !validateSignature(body, process.env.CHANNEL_SECRET!, signature)) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // Parse webhook events
  const events: WebhookEvent[] = JSON.parse(body).events;

  // Process each event
  for (const webhookEvent of events) {
    if (webhookEvent.type === 'message' && webhookEvent.message.type === 'text') {
      await client.replyMessage(webhookEvent.replyToken, {
        type: 'text',
        text: webhookEvent.message.text,
      });
    }
  }

  return { statusCode: 200, body: "OK" };
}