import { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async () => {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
    }));

    const items = result.Items || [];
    // Sort by createdAt desc
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(items),
    };
  } catch (error) {
    console.error('Error listing assets:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Failed to list assets' }),
    };
  }
};

