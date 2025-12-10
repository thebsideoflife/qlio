import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-west-2",
});

export interface VideoContext {
  summary: string;
  transcript: string;
  duration: number;
  tags?: string[];
  availableScenes?: string;
}

export interface UserGoals {
  platform: string;
  intent: string;
  targetAudience?: string;
  style?: string;
}

export interface DirectorSegmentPlan {
  startTime: number;
  endTime: number;
  title: string;
  reasoning: string;
  expectedContent: string;
}

export interface DirectorOutput {
  plan: DirectorSegmentPlan[];
}

export class DirectorAgent {
  static async ideate(
    context: VideoContext,
    goals: UserGoals
  ): Promise<DirectorOutput> {
    const prompt = `
You are a creative video director. Your goal is to select the best segments from a video to create a microdrama for social media.

Video Context:
Duration: ${context.duration} seconds
Summary: ${context.summary}
Tags: ${context.tags?.join(", ")}
Transcript:
${
  context.transcript
    ? context.transcript.substring(0, 15000)
    : "No transcript available."
}

AVAILABLE SCENES (You MUST strictly select from this list):
${context.availableScenes || "No scene list available."}

User Goals:
Platform: ${goals.platform}
Intent: ${goals.intent}
Target Audience: ${goals.targetAudience || "General"}
Style: ${goals.style || "Engaging"}

Task:
Identify 3-5 key segments that form a cohesive narrative.
For each segment, provide:
1. "startTime" and "endTime" (MUST MATCH timestamps from the "AVAILABLE SCENES" list if available, or be precise).
2. "title" (A short creative title for the segment).
3. "reasoning" (why this segment fits the story).
4. "expectedContent" (what happens in this segment).

Constraints:
- Do NOT invent scenes. Use the provided list.
- Ensure segments are at least 5 seconds long.
- Do NOT overlap segments.
- If no scenes match the narrative, pick the most visually interesting ones from the list.

Output strict JSON only. No markdown formatting.
Schema:
{
  "plan": [
    {
      "startTime": number,
      "endTime": number,
      "title": string,
      "reasoning": string,
      "expectedContent": string
    }
  ]
}
`;

    try {
      const command = new InvokeModelCommand({
        modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
              ],
            },
          ],
        }),
      });

      const response = await bedrock.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const content = responseBody.content[0].text;

      // Extract JSON from potential wrapper text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return JSON.parse(content);
    } catch (error) {
      console.error("Director Agent failed:", error);
      throw error;
    }
  }
}
