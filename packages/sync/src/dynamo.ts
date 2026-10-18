// DynamoDB, одна таблица (infra/main.tf): pk = game#<gameId>, sk = ev#<id события>,
// локальный индекс byRecv по r = <время прихода>#<id> — чтение «после курсора».
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { Event } from '@bgq/core';
import type { EventStore } from './store.ts';

export function dynamoStore(table: string, client = new DynamoDBClient({})): EventStore {
  const pk = (gameId: string) => ({ S: `game#${gameId}` });
  return {
    async put(gameId, r, event) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: {
              pk: pk(gameId),
              sk: { S: `ev#${event.id}` },
              r: { S: r },
              json: { S: JSON.stringify(event) },
            },
            // Повторная отправка (ответ потерялся по тайм-ауту) — не дубль, а «уже есть».
            ConditionExpression: 'attribute_not_exists(sk)',
          }),
        );
        return 'stored';
      } catch (e) {
        if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return 'duplicate';
        throw e;
      }
    },
    async list(gameId, after, limit) {
      const out = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byRecv',
          KeyConditionExpression: 'pk = :pk AND r > :after',
          ExpressionAttributeValues: { ':pk': pk(gameId), ':after': { S: after } },
          Limit: limit,
        }),
      );
      const items = (out.Items ?? []).map((i) => ({
        r: i.r?.S ?? '',
        event: JSON.parse(i.json?.S ?? 'null') as Event,
      }));
      return { items, more: out.LastEvaluatedKey !== undefined };
    },
  };
}
