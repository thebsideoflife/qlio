---
title: Quickstart
description: >-
  Upload a video, build a knowledge store, and generate an overview of your
  content.
---

<Note title="Private beta">
Agents are in private beta. To request access, contact your account team. Availability, limits, and API surface may change before general availability.
</Note>

This guide shows how to upload a video, build a knowledge store, and generate an overview of your video content. Additionally, the platform allows for entity extraction and tracking, search functionality, content organization, and more. To explore the capabilities of the platform, see the [Guides](/v1.3/agents/guides) section. For common tasks and multi-step workflows, see the [Recipes](/v1.3/agents/recipes) section.

# Key concepts

This section explains the key concepts and terminology used in this guide:

- **Asset**: Your uploaded content. Once created, you can reference the same asset across multiple operations without uploading the file again.
- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Ingestion configuration**: An optional set of instructions that controls what the platform extracts during indexing. You can provide a natural-language description or a JSON schema.
- **Knowledge store item**: An asset added to a knowledge store. The platform processes each item asynchronously. When processing finishes, the item is ready for downstream tasks.

# Workflow

Upload your video as an asset, then create a knowledge store. Add the asset to the knowledge store. The platform indexes the content asynchronously. When processing finishes, use the Responses API to generate a response from the knowledge store. Note that this guide includes an optional ingestion configuration to show how to guide extraction.

# Prerequisites

- To use the platform, you need an API key:
  <Steps>
  <Step>
  If you don't have an account, [sign up](https://playground.twelvelabs.io/) for a free account.
  </Step>
  <Step>
  Go to the [API Keys](https://playground.twelvelabs.io/dashboard/api-keys) page.
  </Step>
  <Step>
  If you need to create a new key, select the **Create API Key** button. Enter a name and set the expiration period. The default is 12 months.
  </Step>
  <Step>
  Select the **Copy** icon next to your key to copy it to your clipboard.
  </Step>
  </Steps>

- Python 3.8+ with `requests` installed:
  ```shell
  pip install requests
  ```
- A publicly accessible video URL that points directly to a media file. This quickstart demonstrates the URL upload method. For local file uploads, see the [Upload content](/v1.3/agents/guides/upload-content) page.
- Upload limits: Public video URLs up to 2 GB or local video files up to 200 MB. For local files up to 2 GB, see the [Upload content](/v1.3/agents/guides/upload-content) page.

# Starter code

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python maxLines=12

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY}

# Step 1: Upload a video and wait until the asset is ready
response = requests.post(
    f"{BASE_URL}/assets",
    headers=HEADERS,
    files=[("method", (None, "url")), ("url", (None, "<YOUR_VIDEO_URL>"))]
)
asset_id = response.json()["_id"]
print(f"Asset created: {asset_id}")

while True:
    status = requests.get(f"{BASE_URL}/assets/{asset_id}", headers=HEADERS).json()["status"]
    if status == "ready":
        break
    elif status == "failed":
        raise Exception("Asset processing failed")
    print(f"Status: {status}, waiting...")
    time.sleep(5)
print("Asset ready")

# Step 2: Create a knowledge store with an ingestion config (optional but recommended)
response = requests.post(
    f"{BASE_URL}/knowledge-stores",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={
        "name": "My First Knowledge Store",
        "ingestion_config": {
            "enrichment_config": {
                "type": "description",
                "description": "Extract key topics, themes, people, locations, and notable events"
            }
        }
    }
)
store_id = response.json()["_id"]
print(f"Knowledge store created: {store_id}")

# Step 3: Add the video to the knowledge store and wait until indexing completes
response = requests.post(
    f"{BASE_URL}/knowledge-stores/{store_id}/items",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={"asset_id": asset_id}
)
item_id = response.json()["_id"]
print(f"Item added: {item_id}")

while True:
    status = requests.get(
        f"{BASE_URL}/knowledge-stores/{store_id}/items/{item_id}",
        headers=HEADERS
    ).json()["status"]
    if status == "ready":
        break
    elif status == "failed":
        raise Exception("Indexing failed")
    print(f"Status: {status}, waiting...")
    time.sleep(10)
print("Indexing complete")

# Step 4: Generate a response
response = requests.post(
    f"{BASE_URL}/responses",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={
        "model": "jockey1.0",
        "input": [
            {"type": "message", "role": "user", "content": "Give me an overview of this video collection - main themes, key subjects, and any patterns across the videos."}
        ],
        "knowledge_store_id": store_id
    }
)
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            print(content["text"])
```

# Code explanation

<Steps>
  <Step title="Upload a video">
    Upload a video using a publicly accessible URL to create an asset.
    For URL uploads larger than 200 MB, wait until the asset reaches the `ready` status. The platform processes these files asynchronously.
    
  </Step>
  <Step title="Create a knowledge store">
    Create a knowledge store and provide an ingestion config that tells Jockey what to extract. The ingestion config is optional, but it improves the quality of the results. This example uses a natural-language description. The platform also supports defining a JSON schema for structured extraction. For details, see the [Configure ingestion](/v1.3/agents/guides/create-a-knowledge-store/configure-ingestion) page.
  </Step>
  <Step title="Add the video to the knowledge store">
    Add the asset to the knowledge store for indexing.
    Check the status of the knowledge store item until it reaches `ready`. Indexing usually takes longer than the asset processing in step 1.
  </Step>
  <Step title="Generate a response">
    Generate a response from your video collection through the Responses API. This example requests an overview of the main themes, key subjects, and patterns across your videos. The platform searches, tracks entities, and reasons across the knowledge store, then returns a response.
  </Step>
</Steps>

# Next steps

- [Guides](/v1.3/agents/guides) - set up content, configure ingestion, and generate responses
- [Recipes](/v1.3/agents/recipes) - common tasks you can adapt to your use case
