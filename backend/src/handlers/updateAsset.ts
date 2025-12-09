import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing assetId" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    // We expect metadata in the body.
    // We will update the metadata map in DynamoDB.
    
    // Construct UpdateExpression dynamically based on keys provided
    // For simplicity, we'll assume body contains the metadata object to merge/set
    // or specific fields. Let's assume we update the 'metadata' attribute directly or merge into it.
    // Given the previous code stored "metadata" as a map, we can just update that attribute.
    
    // However, DynamoDB update nested maps can be tricky if we want to merge.
    // For now, let's just replace the metadata field or add top-level fields if needed.
    // The requirement is to "answer questions". So we receive answers.

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression: "set metadata = :m",
        ExpressionAttributeValues: {
          ":m": body,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error("Error updating asset:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to update asset" }),
    };
  }
};

