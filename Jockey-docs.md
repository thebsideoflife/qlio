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

---

title: Migrate from Models
description: Compare Agents with Models and move your workflows.

---

TwelveLabs offers two sets of APIs for working with video. Both use the same ingestion flow but support different reasoning scopes.

- **Models**: Search, analyze, and embed individual videos with dedicated APIs.
- **Agents**: Organize, search, track, and extract insights across video collections through a single API.
- **Use both together**: Combine Models for embeddings and per-video analysis with Agents for corpus-level reasoning.

This guide compares the two, helps you evaluate which workflows to migrate, and walks through a search workflow migration step by step.

# Key differences

The following table highlights the key differences between Models and Agents.

| Models                                               | Agents                       | Difference                                                                                                                             |
| ---------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Index                                                | Knowledge store              | A knowledge store contains your videos plus derived understanding - entities, relationships, and embeddings - not just a vector index. |
| Indexed video                                        | Asset + knowledge store item | Upload creates an asset. Adding it to a knowledge store creates an item. One asset can exist in multiple knowledge stores.             |
| Marengo / Pegasus                                    | Jockey                       | No model selection needed. Jockey is a unified model that handles all modalities automatically.                                        |
| `POST /search`                                       | `POST /responses`            | Natural language replaces structured search parameters.                                                                                |
| Search options (visual, conversation, text_in_video) | Automatic                    | Jockey reasons across all modalities without explicit configuration.                                                                   |
| `POST /embed`                                        | No equivalent                | Continue using the Embed API for vector embeddings.                                                                                    |

# Detailed comparison by task

The following table shows which tasks each API supports.

| Task                         | Models         | Agents                                     |
| ---------------------------- | -------------- | ------------------------------------------ |
| Search for moments in videos | ✅ Search API  | ✅ Responses API                           |
| Summarize a single video     | ✅ Analyze API | ⚠️ Not recommended - use Analyze API       |
| Organize videos by topic     | ❌             | ✅ Responses API with structured output    |
| Track entities across videos | ❌             | ✅ Responses API                           |
| Build agent workflows        | ❌             | ✅ Multi-turn sessions + structured output |
| Generate vector embeddings   | ✅ Embed API   | ❌                                         |

Note that agents return text, data references, and timestamps — not processed video. Use these references in your own rendering pipeline.

# Choose the workflows to migrate

Some workflows can move to Agents. Others should stay on the existing Models APIs.

| Current workflow                                       | Recommendation                           | Reason                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search for moments in videos**                       | Evaluate migration to the Responses API. | Agents add cross-video reasoning, multi-turn refinement, and structured output to search workflows.                                                                                      |
| **Analyze a single video** for summaries or Q&A        | Keep using the Analyze API.              | The Analyze API handles stateless, single-video analysis. Agents are built for collections. If your workflow needs reasoning across multiple videos, consider the Responses API instead. |
| **Generate embeddings** for machine-learning pipelines | Keep using the Embed API.                | Agents do not generate vector embeddings.                                                                                                                                                |

TwelveLabs recommends you start with a pilot. Upload a subset of your existing content to a pilot knowledge store. Compare results side by side before migrating production workflows.

# Migrate a search workflow

This example shows how to move a search workflow from Models to Agents. Both approaches start by uploading a video as an asset. The differences begin after upload.

| Step                      | Models                                          | Agents                                             |
| ------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| **1. Upload an asset**    | Upload a video file or URL                      | Same                                               |
| **2. Create a container** | Create an index with engine and modality config | Create a knowledge store - no engine config needed |
| **3. Add the asset**      | Add to index, poll until indexed                | Add to knowledge store, poll until indexed         |
| **4. Query**              | `POST /search` with structured parameters       | `POST /responses` with natural language            |

**What you gain**:

- **No model or engine selection**: Jockey handles all modalities automatically
- **Natural language queries**: describe what you want instead of specifying search options
- **Follow-up queries**: refine results in a multi-turn session
- **Corpus-level reasoning**: generate responses that reason across your entire video collection
- **Structured output**: retrieve typed JSON responses using a schema

For a working code example of the Agents workflow, see the [Quickstart](/v1.3/agents/get-started/quickstart).

<Note title="Private beta limitations">
During the private beta period:
- Webhooks are not available. Use polling to check processing status
- Rate limits may differ from Models
- The API surface may change before general availability
- SLAs do not apply

Models continue to operate. Adopt Agents at your own pace.
</Note>

# Next steps

- [Guides](/v1.3/agents/guides) - set up content, configure ingestion, and generate responses
- [Recipes](/v1.3/agents/recipes) - common tasks you can adapt to your use case

---

## title: Upload content

This guide shows you how to upload video content to the platform as an asset. The platform supports the following upload methods:

- **Direct uploads**: Upload local files (up to 200 MB) or provide a public URL (up to 2 GB). Use direct links to raw media files. The platform does not support video hosting platforms or cloud storage sharing links.
- **Multipart uploads**: Upload local video files up to 2 GB. Use multipart uploads for automatic retries, progress tracking, and improved reliability.

<Note title="Note">
The platform accepts uploads up to 4 GB, but knowledge stores have a 2 GB limit. Files that exceed this limit will fail when you add them to a knowledge store.
</Note>

# Key concepts

- **Asset**: Your uploaded content. Once created, you can reference the same asset across multiple operations without uploading the file again.

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
  `shell
     pip install requests
     `
  {/_ - For multipart uploads with the SDK, install the TwelveLabs Python SDK:
  `shell
    pip install twelvelabs
    ` _/}

# Example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

<Tabs>
  <Tab title="Direct uploads (local)">
    ```python
    import requests

    API_KEY = "<YOUR_API_KEY>"
    BASE_URL = "https://api.twelvelabs.io/v1.3"
    HEADERS = {"x-api-key": API_KEY}

    # Step 1: Upload the file
    response = requests.post(
        f"{BASE_URL}/assets",
        headers=HEADERS,
        files=[
            ("method", (None, "direct")),
            ("file", open("<YOUR_FILE_PATH>", "rb")),
        ]
    )

    # Step 2: Read the response
    asset = response.json()
    print(f"Asset ID: {asset['_id']}, Status: {asset['status']}")
    ```

  </Tab>
  <Tab title="Direct uploads (URL)">
    ```python
    import requests
    import time

    API_KEY = "<YOUR_API_KEY>"
    BASE_URL = "https://api.twelvelabs.io/v1.3"
    HEADERS = {"x-api-key": API_KEY}

    # Step 1: Upload from a URL
    response = requests.post(
        f"{BASE_URL}/assets",
        headers=HEADERS,
        files=[
            ("method", (None, "url")),
            ("url", (None, "<YOUR_VIDEO_URL>")),
        ]
    )
    asset_id = response.json()["_id"]
    print(f"Asset created: {asset_id}")

    # Step 2: Check the status of the asset
    while True:
        status = requests.get(
            f"{BASE_URL}/assets/{asset_id}", headers=HEADERS
        ).json()["status"]
        if status == "ready":
            break
        elif status == "failed":
            raise Exception("Upload processing failed")
        print(f"Status: {status}, waiting...")
        time.sleep(5)
    print("Asset ready")
    ```

  </Tab>
  <Tab title="Multipart uploads">
    ```python
    import requests
    import os

    API_KEY = "<YOUR_API_KEY>"
    BASE_URL = "https://api.twelvelabs.io/v1.3"
    HEADERS = {"x-api-key": API_KEY}
    FILE_PATH = "<YOUR_FILE_PATH>"

    # Step 1: Create an upload session
    file_size = os.path.getsize(FILE_PATH)
    response = requests.post(
        f"{BASE_URL}/assets/multipart-uploads",
        headers=HEADERS,
        json={
            "filename": os.path.basename(FILE_PATH),
            "type": "video",
            "total_size": file_size,
        }
    )
    session = response.json()
    upload_id = session["upload_id"]
    chunk_size = session["chunk_size"]
    upload_urls = {u["chunk_index"]: u["url"] for u in session["upload_urls"]}
    print(f"Upload session created: {upload_id}")

    # Step 2: Upload chunks
    completed_chunks = []
    with open(FILE_PATH, "rb") as f:
        for i in range(1, session["total_chunks"] + 1):
            chunk_data = f.read(chunk_size)

            # Request additional presigned URLs if needed
            if i not in upload_urls:
                resp = requests.post(
                    f"{BASE_URL}/assets/multipart-uploads/{upload_id}/presigned-urls",
                    headers=HEADERS,
                    json={"start": i, "count": min(50, session["total_chunks"] - i + 1)}
                )
                for u in resp.json()["upload_urls"]:
                    upload_urls[u["chunk_index"]] = u["url"]

            put_resp = requests.put(
                upload_urls[i],
                data=chunk_data,
                headers={"Content-Type": "application/octet-stream"}
            )
            completed_chunks.append({
                "chunk_index": i,
                "proof": put_resp.headers["ETag"],
                "proof_type": "etag",
                "chunk_size": len(chunk_data)
            })
            print(f"Uploaded chunk {i}/{session['total_chunks']}")

    # Step 3: Report completed chunks
    response = requests.post(
        f"{BASE_URL}/assets/multipart-uploads/{upload_id}",
        headers=HEADERS,
        json={"completed_chunks": completed_chunks}
    )
    result = response.json()
    print(f"Asset ID: {session['asset_id']}")
    print(f"Upload complete ({result['total_completed']}/{session['total_chunks']} chunks)")
    ```

    <Note>
    This example condenses the multipart upload flow into three steps. For the complete flow with parallel uploads and session management, see the [Multipart uploads API reference](/v1.3/api-reference/upload-content/multipart-uploads).
    </Note>

  </Tab>
{/*  <Tab title="Multipart (SDK)">
    ```python
    from twelvelabs import TwelveLabs

    # Step 1: Initialize the client
    client = TwelveLabs(api_key="<YOUR_API_KEY>")

    # Step 2: Upload the file
    def progress_callback(progress):
        print(f"Progress: {progress.percentage:.1f}% ({progress.completed_chunks}/{progress.total_chunks} chunks)")

    result = client.multipart_upload.upload_file(
        "<YOUR_FILE_PATH>",
        progress_callback=progress_callback,
    )
    print(f"Asset ID: {result.asset_id}")
    ```

</Tab> \*/}
</Tabs>

# Code explanation

<Tabs>
  <Tab title="Direct uploads (local)">
    <Steps>
      <Step title="Upload the file">
        Call the [`POST /assets`](/v1.3/api-reference/upload-content/direct-uploads/create) endpoint with your file.

        **Parameters**:
        - `method`: The upload method. Set to `direct` for local files.
        - `file`: The local file to upload. Maximum size: 200 MB for video and audio, 5 MB for images.

        **Return value**: An asset object containing, among other information, the following fields:
        - `_id`: The unique identifier of the asset.
        - `status`: The current status. Direct uploads under 200 MB return synchronously with `ready` status.
        - `filename`: The name of the uploaded file.
      </Step>
      <Step title="Read the response">
        This example prints the asset ID and status to the standard output.
      </Step>
    </Steps>

  </Tab>
  <Tab title="Direct uploads (URL)">
    <Steps>
      <Step title="Upload from a URL">
        Call the [`POST /assets`](/v1.3/api-reference/upload-content/direct-uploads/create) endpoint with your video URL. Use direct links to raw media files. The platform does not support video hosting platforms or cloud storage sharing links.

        **Parameters**:
        - `method`: The upload method. Set to `url` for publicly accessible URLs.
        - `url`: The publicly accessible URL of the media file.

        **Return value**: An asset object containing, among other information, the following fields:
        - `_id`: The unique identifier of the asset.
        - `status`: The current status. URL uploads over 200 MB return with `processing` status.
      </Step>
      <Step title="Check the status of the asset">
        Poll the [`GET /assets/{asset_id}`](/v1.3/api-reference/upload-content/direct-uploads/retrieve) endpoint until the `status` field reaches `ready`. This example checks every 5 seconds. An asset must reach `ready` status before you can add it to a knowledge store.

        **Parameters**:
        - `asset_id`: The unique identifier of the asset, from the previous step.

        **Return value**: An asset object. Check the `status` field for the current state. The possible values are `processing`, `ready`, and `failed`.
      </Step>
    </Steps>

  </Tab>
  <Tab title="Multipart uploads">
    <Steps>
      <Step title="Create an upload session">
        Call the [`POST /assets/multipart-uploads`](/v1.3/api-reference/upload-content/multipart-uploads/create) endpoint with the filename, type, and total file size. The platform uses the file size to calculate the optimal chunk size and generate presigned URLs.

        **Parameters**:
        - `filename`: The name of the file to upload.
        - `type`: The asset type. Must be `video`.
        - `total_size`: The total file size in bytes.

        **Return value**: A session object containing, among other information, the following fields:
        - `upload_id`: The unique identifier of the upload session. Store this value - you need it for subsequent steps. The session remains valid for 24 hours.
        - `asset_id`: The unique identifier for the asset being created. Available for use after the upload completes.
        - `upload_urls`: An array of presigned URL objects. Each object contains a `chunk_index` and a `url`. The initial response may not include URLs for all chunks.
        - `chunk_size`: The size in bytes for each chunk. The last chunk may be smaller.
        - `total_chunks`: The total number of chunks to upload.
      </Step>
      <Step title="Upload chunks">
        Read the file in chunks of the specified size. Upload each chunk to its presigned URL with a `PUT` request. Save the `ETag` header from each response - you need it as proof of upload in the next step. Each presigned URL can only be used once and expires after 1 hour.

        If the initial response does not include URLs for all chunks, call the [`POST /assets/multipart-uploads/{upload_id}/presigned-urls`](/v1.3/api-reference/upload-content/multipart-uploads/get-additional-presigned-urls) endpoint to request additional URLs.

        **Parameters** (for requesting additional URLs):
        - `start`: The index of the first chunk to generate URLs for. Chunks use 1-based numbering.
        - `count`: The number of URLs to generate. Maximum: 50 per request.
      </Step>
      <Step title="Report completed chunks">
        Call the [`POST /assets/multipart-uploads/{upload_id}`](/v1.3/api-reference/upload-content/multipart-uploads/report-chunk-batch) endpoint with the list of uploaded chunks. You can report chunks in batches of up to 50, in any order.

        **Parameters**:
        - `completed_chunks`: An array of chunk objects. Each object contains:
          - `chunk_index`: The chunk number (1-based).
          - `proof`: The `ETag` value from the chunk upload response.
          - `proof_type`: The verification method. Must be `etag`.
          - `chunk_size`: The number of bytes uploaded for this chunk.

        **Return value**: A response object containing, among other information, the following fields:
        - `total_completed`: The cumulative count of all unique chunks reported. When this value equals `total_chunks` from Step 1, the upload is complete.
        - `asset_id`: The unique identifier of the asset.
      </Step>
    </Steps>

  </Tab>
</Tabs>

# Next steps

- [Create a knowledge store](/v1.3/agents/guides/create-a-knowledge-store) - create a knowledge store to hold your videos and enable querying

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/guides/uploading_content.ipynb)

# API reference

- [Upload content](/v1.3/api-reference/upload-content)

---

## title: Create a knowledge store

This guide shows you how to create a knowledge store and optionally customize what the platform extracts during indexing.

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Ingestion configuration**: An optional set of instructions that controls what the platform extracts during indexing. You can provide a natural-language description or a JSON schema.

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

# Create the knowledge store

To create a knowledge store, use the example below, replacing the placeholders surrounded by `<>` with your values:

```python

HEADERS = {"x-api-key": "<YOUR_API_KEY>", "Content-Type": "application/json"}
BASE_URL = "https://api.twelvelabs.io/v1.3"

response = requests.post(
    f"{BASE_URL}/knowledge-stores",
    headers=HEADERS,
    json={"name": "<YOUR_KNOWLEDGE_STORE_NAME>"}
)
store_id = response.json()["_id"]
print(f"Knowledge store created: {store_id}")
```

# Configure ingestion

Jockey works out of the box with default extraction. To shape what the platform emphasizes during indexing, pass an `ingestion_config` when you create the knowledge store:

```python
response = requests.post(
    f"{BASE_URL}/knowledge-stores",
    headers=HEADERS,
    json={
        "name": "Marketing Videos",
        "ingestion_config": {
            "enrichment_config": {
                "type": "description",
                "description": "Focus on brand mentions, product appearances, and audience reactions"
            }
        }
    }
)
```

For guidance on choosing between default extraction, a natural-language description, and a JSON schema, see [Configure ingestion](/v1.3/agents/guides/create-a-knowledge-store/configure-ingestion).

# Add metadata

Attach key-value pairs to a knowledge store for labeling and organizing your stores. Maximum 16 pairs with string keys and values.

```python
response = requests.post(
    f"{BASE_URL}/knowledge-stores",
    headers=HEADERS,
    json={
        "name": "Q1 Marketing Videos",
        "metadata": {
            "team": "marketing",
            "quarter": "2026-Q1"
        }
    }
)
```

# Next steps

- [Add assets to a knowledge store](/v1.3/agents/guides/add-assets) - add your uploaded assets to the knowledge store for indexing

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/guides/building_knowledge_stores.ipynb)

# API reference

- [Create a knowledge store](/v1.3/api-reference/knowledge-stores/create-knowledge-store)

---

## title: Add assets to a knowledge store

This guide shows you how to add an uploaded asset to a knowledge store and wait for indexing to complete.

# Key concepts

- **Asset**: Your uploaded content. Once created, you can reference the same asset across multiple operations without uploading the file again.
- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Knowledge store item**: An asset added to a knowledge store. The platform processes each item asynchronously. When processing finishes, the item is ready for downstream tasks.

# Prerequisites

- You've already uploaded your content, and the asset has reached the `ready` status. See the [Upload content](/v1.3/agents/guides/upload-content) page for details.
- You've already created a knowledge store. See the [Create a knowledge store](/v1.3/agents/guides/create-a-knowledge-store) page for details.

# Example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
ASSET_ID = "<YOUR_ASSET_ID>"
STORE_ID = "<YOUR_STORE_ID>"

# Step 1: Add the asset to the knowledge store
response = requests.post(
    f"{BASE_URL}/knowledge-stores/{STORE_ID}/items",
    headers=HEADERS,
    json={"asset_id": ASSET_ID}
)
item_id = response.json()["_id"]
print(f"Item added: {item_id}")

# Step 2: Wait for indexing
while True:
    status = requests.get(
        f"{BASE_URL}/knowledge-stores/{STORE_ID}/items/{item_id}",
        headers={"x-api-key": API_KEY}
    ).json()["status"]
    if status == "ready":
        break
    elif status == "failed":
        raise Exception("Indexing failed")
    print(f"Status: {status}, waiting...")
    time.sleep(10)
print("Indexing complete")
```

# Code explanation

<Steps>
  <Step title="Add the asset to the knowledge store">
    Send a `POST` request to `/knowledge-stores/{id}/items` with the asset ID. The platform creates a knowledge store item and begins indexing asynchronously.
  </Step>
  <Step title="Wait for indexing">
    Poll the status of the knowledge store item until it reaches `ready`. Indexing usually takes longer than the asset processing that happens after upload. One asset can exist in multiple knowledge stores. For the full list of knowledge store item statuses, see the [Knowledge stores](/v1.3/agents/concepts/knowledge-stores) page.
  </Step>
</Steps>

# Next steps

- [Create a response](/v1.3/agents/guides/create-a-response) - generate responses from your video collection through the Responses API

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/guides/building_knowledge_stores.ipynb)

# API reference

- [Create a knowledge store item](/v1.3/api-reference/knowledge-store-items/create-a-knowledge-store-item)
- [Retrieve a knowledge store item](/v1.3/api-reference/knowledge-store-items/retrieve-a-knowledge-store-item)

---

## title: Create a response

This guide shows you how to generate a response from a knowledge store and customize Jockey's behavior for a specific domain.

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Instructions**: A system-level prompt that shapes Jockey's behavior for a specific domain or task. Same model, same endpoint - different results depending on the instructions you provide.

# Prerequisites

- You've already uploaded your content, and the asset has reached the `ready` status. See the [Upload content](/v1.3/agents/guides/upload-content) page for details.
- You've already created a knowledge store. See the [Create a knowledge store](/v1.3/agents/guides/create-a-knowledge-store) page for details.
- You've already added at least one asset to the knowledge store, and the knowledge store item has reached the `ready` status. See the [Add assets to a knowledge store](/v1.3/agents/guides/add-assets) page for details.

# Example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_STORE_ID>"

# Step 1: Create a response
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "input": [
            {"type": "message", "role": "user", "content": "What are the main themes across these videos?"}
        ],
        "knowledge_store_id": STORE_ID
    }
)

# Step 2: Read the response
result = response.json()
print(f"ID: {result['id']}")
print(f"Session: {result['session_id']}")

for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            print(content["text"])

print(f"Tokens: {result['usage']}")
```

# Code explanation

<Steps>
  <Step title="Create a response">
    Send a `POST` request to `/responses` with a natural-language message in the `input` array and the knowledge store ID in `knowledge_store_id`. Every request requires exactly one knowledge store ID. The response object contains:

    ```json
    {
      "id": "resp_abc123",
      "session_id": "sess_xyz789",
      "status": "completed",
      "output": [
        {
          "type": "message",
          "content": [{"type": "output_text", "text": "The main themes across your videos include..."}]
        }
      ],
      "usage": {"input_tokens": 1250, "output_tokens": 340}
    }
    ```

  </Step>
  <Step title="Read the response">
    Iterate through the `output` array to extract the generated text. The response also includes a `session_id` you can use for follow-up turns (see [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions)) and a `usage` object with token counts.
  </Step>
</Steps>

# Customize behavior with instructions

Add the `instructions` field to specialize Jockey for your domain. Same API, same model - different behavior depending on what you provide.

```python
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "instructions": "You are a sports analyst. Focus on player performance, tactics, and key moments.",
        "input": [
            {"type": "message", "role": "user", "content": "Summarize the key plays from this game"}
        ],
        "knowledge_store_id": STORE_ID
    }
)
```

Swap the `instructions` field to reshape Jockey for different contexts:

| Domain     | Example instructions                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Security   | "You are a security analyst. Prioritize temporal accuracy and flag low-confidence identifications."               |
| Media      | "You are an editorial assistant. Focus on visual quality, pacing, and narrative arc."                             |
| Compliance | "You are a compliance reviewer. Identify claims, disclaimers, and required disclosures."                          |
| Education  | "You are a learning designer. Analyze pedagogical effectiveness, teaching methods, and assessment opportunities." |

# Inspect intermediate outputs

Jockey performs multi-step reasoning internally - searching, analyzing, and synthesizing across your videos. Add `"intermediate_outputs"` to the `include` array to see these reasoning steps alongside the final answer. This is useful for debugging or understanding how Jockey arrived at a conclusion.

```python
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "input": [
            {"type": "message", "role": "user", "content": "What are the main themes?"}
        ],
        "knowledge_store_id": STORE_ID,
        "include": ["intermediate_outputs"]
    }
)
```

# Capabilities

The Responses API handles a wide range of tasks through the same endpoint. These examples are not exhaustive.

| Capability           | Example prompt                                                | Recipe                                                                           |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Corpus overview      | "Give me a comprehensive overview of this video collection"   | [Generate a corpus overview](/v1.3/agents/recipes/get-a-corpus-overview)         |
| Entity extraction    | "List every person, place, and object across all videos"      | [Extract entities](/v1.3/agents/recipes/extract-entities)                        |
| Search and discovery | "Find all moments where someone is presenting to an audience" | [Search videos](/v1.3/agents/recipes/search-videos)                              |
| Content organization | "What are the best ways to organize this collection?"         | [Find organization axes](/v1.3/agents/recipes/find-organization-axes)            |
| Cross-video tracking | "Track the person in the blue jacket across all footage"      | [Cross-video entity tracking](/v1.3/agents/recipes/track-entities-across-videos) |
| Content enrichment   | "Analyze these videos through the lens of brand perception"   | [Enrich content](/v1.3/agents/recipes/enrich-content)                            |

For complete runnable code, see [Recipes](/v1.3/agents/recipes/get-a-corpus-overview).

# Common pitfalls

- **The knowledge store must have ready items.** If no items are `ready`, the response has nothing to reason over.
- **Knowledge store ID required.** Every request must include a `knowledge_store_id` field.
- **Input format matters.** Each message needs `type`, `role`, and `content` fields.

# Next steps

- [Streaming](/v1.3/agents/guides/create-a-response/streaming) - receive tokens in real time instead of waiting for the full response
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - receive typed JSON by providing a schema
- [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions) - maintain conversation context across requests

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/guides/querying.ipynb)

# API reference

- [Create a response](/v1.3/api-reference/responses/create-response)

---

title: Generate a corpus overview
description: >-
Summarize an entire video collection — themes, subjects, content types,
patterns, and key statistics — in a single request.

---

This recipe shows you how to summarize an entire video collection — themes, subjects, content types, patterns, and key statistics — in a single request. You can get the overview as prose or as structured JSON.

**Use cases**:

- **Collection onboarding**: Summarize a new collection before starting development
- **Dashboard generation**: Create collection summaries for a UI or reporting tool
- **Pipeline input**: Feed collection context to a downstream agent or workflow

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a single call to the [Responses API](/v1.3/api-reference/responses/create-response) with a prompt that requests a collection summary. This recipe shows two approaches: a plain-text overview that needs only a prompt, and a structured overview that adds a JSON schema to define the output format. The model reasons across your knowledge store, identifies themes and patterns, and returns results in the format you chose. You can adapt this recipe to target a specific domain or ask a different question about your collection.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

<Tabs>
  <Tab title="Plain text">
    ```python
    import requests

    API_KEY = "<YOUR_API_KEY>"
    BASE_URL = "https://api.twelvelabs.io/v1.3"
    HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
    STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

    # Step 1: Send the request to the Responses API
    response = requests.post(
        f"{BASE_URL}/responses",
        headers=HEADERS,
        json={
            "model": "jockey1.0",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "Give me a comprehensive overview of this video collection. Include main themes, recurring subjects, content types, and any notable patterns."
                }
            ],
            "knowledge_store_id": STORE_ID
        }
    )

    # Step 2: Print the response
    result = response.json()
    for output in result["output"]:
        if output["type"] == "message":
            for content in output["content"]:
                print(content["text"])
    ```

  </Tab>
  <Tab title="Structured output">
    ```python
    import json
    import requests

    API_KEY = "<YOUR_API_KEY>"
    BASE_URL = "https://api.twelvelabs.io/v1.3"
    HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
    STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

    # Step 1: Define a JSON schema for the collection overview
    overview_schema = {
        "type": "object",
        "properties": {
            "total_videos": {"type": "integer"},            # Number of videos in the collection
            "themes": {                                      # Recurring themes across videos
                "type": "array",
                "items": {"type": "string"}
            },
            "content_types": {                               # Production formats (tutorial, demo, etc.)
                "type": "array",
                "items": {"type": "string"}
            },
            "key_subjects": {                                # Main subjects or topics covered
                "type": "array",
                "items": {"type": "string"}
            },
            "patterns": {                                    # Notable patterns or trends
                "type": "array",
                "items": {"type": "string"}
            },
            "summary": {"type": "string"}                   # Overall narrative summary
        }
    }

    # Step 2: Send the request to the Responses API
    response = requests.post(
        f"{BASE_URL}/responses",
        headers=HEADERS,
        json={
            "model": "jockey1.0",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "Give me a structured overview of this video collection."
                }
            ],
            "knowledge_store_id": STORE_ID,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "corpus_overview",
                    "schema": overview_schema
                }
            }
        }
    )

    # Step 3: Parse the structured response
    result = response.json()
    for output in result["output"]:
        if output["type"] == "message":
            for content in output["content"]:
                overview = json.loads(content["text"])
                print(f"Videos: {overview['total_videos']}")
                print(f"Themes: {', '.join(overview['themes'])}")
                print(f"Summary: {overview['summary']}")
    ```

  </Tab>
</Tabs>

# Code explanation

<Tabs>
  <Tab title="Plain text">
    <Steps>
      <Step title="Request a collection overview">
        Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your prompt.

        **Parameters**:
        - `model`: The model to use. Must be `jockey1.0`.
        - `input`: An array of input items. The `content` field contains your natural-language prompt. This example requests a comprehensive overview including themes, subjects, content types, and patterns.
        - `knowledge_store_id`: The unique identifier of the knowledge store to use.

        **Return value**: A response object containing, among other information, the following fields:
        - `id`: A unique identifier for this response.
        - `knowledge_store_id`: The knowledge store this response was generated against.
        - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
        - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
        - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
        - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.
      </Step>
      <Step title="Print the response">
        Each output item with `type: "message"` contains an array named `content`. The `text` field in each content part contains the model's plain-text overview.
      </Step>
    </Steps>

  </Tab>
  <Tab title="Structured output">
    <Steps>
      <Step title="Define the output schema">
        Create a JSON schema that describes the overview data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
      </Step>
      <Step title="Request a structured overview">
        Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema and prompt.

        **Parameters**:
        - `model`: The model to use. Must be `jockey1.0`.
        - `input`: An array of input items. The `content` field contains your natural-language prompt. This example requests a structured overview of the entire collection.
        - `knowledge_store_id`: The unique identifier of the knowledge store to use.
        - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

        **Return value**: A response object containing, among other information, the following fields:
        - `id`: A unique identifier for this response.
        - `knowledge_store_id`: The knowledge store this response was generated against.
        - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
        - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
        - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
        - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.
      </Step>
      <Step title="Parse the response">
        Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
      </Step>
    </Steps>

  </Tab>
</Tabs>

# Example response

<Tabs>
  <Tab title="Plain text">
    The `text` field inside each content part contains the model's overview formatted as Markdown. A typical response looks like this:

    ```text
    ### Overall character
    - **Content type:** product tutorials, customer interviews, and feature demos
    - **Primary audience:** developers and product managers
    - **Structure:** a growing library of short-form instructional and promotional content

    ### Main themes
    - **Product onboarding**: step-by-step walkthroughs of initial setup and core workflows
    - **Feature announcements**: quarterly release highlights and capability demos
    - **Customer success**: interviews and testimonials from active users

    ### Recurring subjects
    - Dashboard and analytics tooling
    - API authentication and integration workflows
    - Mobile SDK setup and troubleshooting

    ### Notable patterns
    - Tutorial output clusters around product launch dates
    - Most webinars include a Q&A segment in the final third
    - Interview content appears on a quarterly cadence
    ```

    <Note title="Note">
    The model returns Markdown-formatted text. If your downstream pipeline expects plain prose, strip the Markdown formatting before processing.
    </Note>

  </Tab>
  <Tab title="Structured output">
    The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

    ```json
    {
      "total_videos": 12,
      "themes": ["product onboarding", "feature announcements", "customer success", "API integration"],
      "content_types": ["tutorials", "demos", "webinars", "interviews"],
      "key_subjects": ["analytics dashboard", "API authentication", "mobile SDK", "billing workflows"],
      "patterns": ["tutorial output clusters around launch dates", "webinars include a Q&A segment in the final third"],
      "summary": "A product-focused collection of 12 videos spanning tutorials, demos, webinars, and interviews. Content centers on onboarding and feature adoption, with tutorial output concentrated around launch cycles."
    }
    ```

  </Tab>
</Tabs>

<Note title="Note">
The model evaluates the actual content in your knowledge store. Results change depending on the videos you have indexed.
</Note>

# Variations

Change the prompt or add the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter to adapt this recipe for different analytical perspectives.

- **Domain-focused**: Set the `instructions` parameter to "You are a media analyst" to shape the overview for a specific audience.
- **Comparative**: Change the prompt to "How does this collection compare to a typical corporate training library?"
- **Gap analysis**: Change the prompt to "What topics are underrepresented in this collection?"

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/get_corpus_overview.ipynb)

# See also

- [Organize a video library](/v1.3/agents/recipes/organize-a-video-library) - uses a corpus overview as the first step in a full workflow
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Search videos
description: >-
Find specific moments, topics, or content across your video collection using
natural language and get structured results with video references, timestamps,
and relevance context.

---

This recipe shows you how to search across a video collection using natural language and retrieve structured results. The response includes video references, timestamps, descriptions, and relevance scores — ready for your search interface or processing pipeline.

**Use cases**:

- **Content discovery**: Find specific moments in a large collection without manual review
- **Visual and semantic search**: Locate scenes that match a visual, audio, or semantic description
- **In-app search features**: Build video search into your application with machine-readable results

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a single call to the [Responses API](/v1.3/api-reference/responses/create-response) that combines two elements: a JSON schema that defines the result data structure and a prompt that describes what you want to find. The model reasons across your knowledge store, matches moments against visual content, audio, spoken words, and semantic meaning, and returns structured search results. You can adapt this recipe to search for different content types or match different criteria.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Define a JSON schema for the search results
search_schema = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "video_reference": {"type": "string"},    # Source video identifier
                    "timestamp": {"type": "string"},          # When the moment occurs
                    "description": {"type": "string"},        # What happens at this moment
                    "relevance": {"type": "string"}           # Why this matches the query
                }
            }
        },
        "total_results": {"type": "integer"},       # Number of matches found
        "query_interpretation": {"type": "string"}  # How the model interpreted the query
    }
}

# Step 2: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Find all moments where someone is presenting to an audience"
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "search_results",
                "schema": search_schema
            }
        }
    }
)

# Step 3: Parse the structured response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            search = json.loads(content["text"])
            print(f"Found {search['total_results']} results")
            print(f"Interpreted as: {search['query_interpretation']}\n")
            for r in search["results"]:
                print(f"  [{r['timestamp']}] {r['video_reference']}")
                print(f"    {r['description']}")
                print(f"    Relevance: {r['relevance']}\n")
```

# Code explanation

<Steps>
  <Step title="Define the output schema">
    Create a JSON schema that describes the search result data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Search the collection">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema and search prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `input`: An array of input items. The `content` field contains your natural-language search query. This example searches for moments where someone presents to an audience.
    - `knowledge_store_id`: The unique identifier of the knowledge store to search.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "results": [
    {
      "video_reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a#05:22-07:14",
      "timestamp": "05:22-07:14",
      "description": "Speaker walks to the front of the room and begins a slide presentation",
      "relevance": "Very high — presenter addressing a seated audience with visual aids"
    },
    {
      "video_reference": "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c#12:45-14:30",
      "timestamp": "12:45-14:30",
      "description": "Keynote speaker demonstrates product features on stage",
      "relevance": "High — live presentation to a large audience with product demo"
    }
  ],
  "total_results": 2,
  "query_interpretation": "Find moments where a person is actively presenting or speaking to a group of people"
}
```

<Note title="Note">
The `video_reference` field contains the asset identifier of the knowledge store item, followed by the matching timestamp range separated by `#`. The `timestamp` field contains the same range in `MM:SS-MM:SS` format. Use the asset identifier to look up the source video in your knowledge store.
</Note>

# Variations

Change the prompt and schema to adapt this recipe for different search scenarios. The model matches against visual content, audio, spoken words, and semantic meaning.

- **Search by visual description**: Change the prompt to describe a scene — "outdoor scenes with water" or "product being held up to camera."
- **Search by audio or speech**: Search for spoken content — "someone laughing" or "mentions of quarterly revenue."
- **Search by tone or mood**: Describe the feel of a moment — "heated discussion" or "celebratory reactions."
- **Rank results**: Ask the model to rank matches — "Find and rank the top 5 most visually striking moments."
- **Narrow the scope**: Add the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter to constrain the search — for example, "Only search the first 2 minutes of each video."
- **Refine with follow-up turns**: Use a [multi-turn session](/v1.3/agents/guides/create-a-response/multi-turn-sessions) to adjust results: "Show me more like the third result."

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/search_videos.ipynb)

# See also

- [Assemble highlight reels](/v1.3/agents/recipes/assemble-highlight-reels) - uses search to find clips for assembly
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Extract entities
description: >-
List all entities found across your video collection — people, places,
objects, brands, and concepts — with their type, frequency, and source videos.

---

This recipe shows you how to extract every distinct entity from your video collection. The response includes each entity's name, type, frequency, and the videos it appears in — ready for a content index, tagging system, or downstream pipeline.

**Use cases**:

- **Content indexing**: Build a searchable catalog of who and what appears across your videos
- **Classification pipelines**: Feed entity lists to downstream tagging or categorization systems
- **Cross-video analysis**: Find which entities appear most frequently or span multiple videos

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a single call to the [Responses API](/v1.3/api-reference/responses/create-response) that combines two elements: a JSON schema that defines the entity data structure, and a prompt that describes what to extract. The model reasons across your knowledge store, identifies every distinct entity, and returns structured results that match your schema. You can adapt this recipe to extract different entity types or apply different extraction criteria.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Define a JSON schema for the entity list
entity_schema = {
    "type": "object",
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},            # Entity name (person, place, brand, etc.)
                    "type": {"type": "string"},            # Category: person, place, object, brand, concept
                    "frequency": {"type": "string"},       # How often the entity appears
                    "appears_in": {                        # Videos containing this entity
                        "type": "array",
                        "items": {"type": "string"}
                    }
                }
            }
        },
        "entity_count": {"type": "integer"}                # Total number of distinct entities
    }
}

# Step 2: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "List every distinct entity across all videos - people, places, objects, brands, and concepts. Include how frequently each appears."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "entity_list",
                "schema": entity_schema
            }
        }
    }
)

# Step 3: Parse the structured response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            data = json.loads(content["text"])
            print(f"Found {data['entity_count']} entities:\n")
            for entity in data["entities"]:
                print(f"  [{entity['type']}] {entity['name']} - {entity['frequency']}")
                if entity.get("appears_in"):
                    print(f"    Videos: {', '.join(entity['appears_in'])}")
```

# Code explanation

<Steps>
  <Step title="Define the output schema">
    Create a JSON schema that describes the entity data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Extract entities">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema and prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example asks the model to list every distinct entity across all videos, including frequency.
    - `knowledge_store_id`: The unique identifier of the knowledge store to use.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "entities": [
    {
      "name": "Sarah Chen",
      "type": "person",
      "frequency": "42 spans",
      "appears_in": [
        "069eb4e8-aeb0-7e83-8000-86413fcc296a",
        "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c"
      ]
    },
    {
      "name": "Dashboard Analytics",
      "type": "concept",
      "frequency": "18 spans",
      "appears_in": ["069eb4e8-aeb0-7e83-8000-86413fcc296a"]
    },
    {
      "name": "San Francisco",
      "type": "place",
      "frequency": "5 spans",
      "appears_in": [
        "069eb4e8-aeb0-7e83-8000-86413fcc296a",
        "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c"
      ]
    }
  ],
  "entity_count": 3
}
```

<Note title="Notes">
- The `frequency` field reports the number of indexed spans where the entity appears, not the number of videos.
- The `appears_in` field lists the asset identifiers of the knowledge store items that contain the entity.
</Note>

# Variations

Change the prompt to adapt this recipe for different extraction needs.

- **Filter by entity type**: Change the prompt to "List only the people who appear in these videos."
- **Cross-video presence**: Change the prompt to "Which entities appear in more than one video?"
- **Include relationships**: Change the prompt to "List entities and describe how they relate to each other."

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/extract_entities.ipynb)

# See also

- [Track entities across videos](/v1.3/agents/recipes/track-entities-across-videos) - follow a specific entity across multiple videos
- [Organize a video library](/v1.3/agents/recipes/organize-a-video-library) - use entity extraction for categorization
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Find organization axes
description: >-
Discover the best dimensions for organizing your video collection, scored by
effectiveness.

---

This recipe shows you how to discover the best dimensions for organizing your video collection. The response includes ranked categorization strategies with effectiveness scores, expected groups, and example categories — ready for data-driven organization decisions.

**Use cases**:

- **New collection exploration**: Discover natural groupings in a video library you haven't categorized yet
- **Strategy comparison**: Evaluate categorization approaches side by side before committing to a taxonomy
- **Organization pipeline**: Feed scored axes into a workflow that categorizes every video

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Instructions**: Additional guidance that shapes the model's behavior for a specific domain or task. You pass it in the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a single call to the [Responses API](/v1.3/api-reference/responses/create-response) that combines three elements: a JSON schema that defines the axis data structure, instructions that give the model a specific role and domain guidance, and a prompt that describes what you want evaluated. The model reasons across your knowledge store, evaluates possible categorization strategies, and returns ranked results with effectiveness scores. You can adapt this recipe to evaluate different domains or apply different ranking criteria.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Define a JSON schema for the organization axes
axes_schema = {
    "type": "object",
    "properties": {
        "axes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "axis": {"type": "string"},                # Name of the categorization dimension
                    "description": {"type": "string"},         # What this axis measures or captures
                    "expected_groups": {"type": "integer"},     # Estimated number of categories
                    "example_categories": {                     # Sample category names
                        "type": "array",
                        "items": {"type": "string"}
                    },
                    "effectiveness_score": {"type": "number"}, # 0-1 score for separation quality
                    "rationale": {"type": "string"}            # Why this axis works well (or not)
                }
            }
        },
        "recommendation": {"type": "string"}                  # Overall best-strategy recommendation
    }
}

# Step 2: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "instructions": "You are a content strategist. Analyze the video collection and recommend the most effective ways to organize it. Score each axis by how well it separates content into distinct, useful groups.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "What are the top 5 best ways to organize this video collection? Score each from 0-1 based on how cleanly it separates the content."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "organization_axes",
                "schema": axes_schema
            }
        }
    }
)

# Step 3: Parse the structured response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            data = json.loads(content["text"])
            print(f"Recommendation: {data['recommendation']}\n")
            for ax in data["axes"]:
                print(f"  {ax['axis']} (score: {ax['effectiveness_score']})")
                print(f"    {ax['description']}")
                print(f"    Groups: {ax['expected_groups']} - {', '.join(ax['example_categories'])}")
                print(f"    Why: {ax['rationale']}\n")
```

# Code explanation

<Steps>
  <Step title="Define the output schema">
    Create a JSON schema that describes the axis data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Request organization strategies">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema, instructions, and prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `instructions`: Additional guidance that shapes the model's behavior for a specific domain or task. Maximum length: 2,000 characters. This example uses a content strategist role that evaluates categorization strategies.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example asks the model to recommend the top five categorization strategies and score each on a 0–1 scale.
    - `knowledge_store_id`: The unique identifier of the knowledge store to use.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "axes": [
    {
      "axis": "Content Type",
      "description": "Groups videos by their format and production style",
      "expected_groups": 4,
      "example_categories": [
        "tutorials",
        "product demos",
        "interviews",
        "presentations"
      ],
      "effectiveness_score": 0.92,
      "rationale": "Each video clearly fits one format, producing well-separated groups with minimal overlap"
    },
    {
      "axis": "Product Area",
      "description": "Groups videos by the feature or product they cover",
      "expected_groups": 5,
      "example_categories": [
        "analytics dashboard",
        "API platform",
        "mobile SDK",
        "integrations",
        "billing"
      ],
      "effectiveness_score": 0.85,
      "rationale": "Videos focus on specific product areas, creating meaningful clusters for feature-based navigation"
    },
    {
      "axis": "Target Audience",
      "description": "Groups videos by the intended viewer",
      "expected_groups": 3,
      "example_categories": ["developers", "product managers", "executives"],
      "effectiveness_score": 0.78,
      "rationale": "Most videos target a clear audience, though some span multiple groups"
    },
    {
      "axis": "Difficulty Level",
      "description": "Groups videos by the assumed prior knowledge of the viewer",
      "expected_groups": 3,
      "example_categories": ["beginner", "intermediate", "advanced"],
      "effectiveness_score": 0.71,
      "rationale": "Difficulty is readable across most content but some videos mix levels within a single session"
    },
    {
      "axis": "Recency",
      "description": "Groups videos by when they were produced relative to product releases",
      "expected_groups": 4,
      "example_categories": [
        "pre-launch",
        "launch week",
        "post-launch",
        "evergreen"
      ],
      "effectiveness_score": 0.63,
      "rationale": "Useful for filtering out outdated content but requires timestamp metadata to apply reliably"
    }
  ],
  "recommendation": "Content Type produces the cleanest separation. Combine with Product Area as a secondary axis for a two-level taxonomy."
}
```

<Note title="Note">
The model evaluates each axis against the actual content in your knowledge store. Scores and recommendations change depending on the videos you have indexed.
</Note>

# Variations

Change the instructions and prompt to adapt this recipe for different organizational needs.

- **Domain-constrained**: Set the `instructions` parameter to a team-specific perspective: "marketing strategist," "education specialist," or "compliance officer."
- **Audience-centric**: Change the prompt to "How would different audiences want this collection organized?"
- **Hierarchical taxonomy**: Change the prompt to "Suggest a two-level taxonomy: primary axes and sub-axes for each."

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/find_organization_axes.ipynb)

# See also

- [Organize a video library](/v1.3/agents/recipes/organize-a-video-library) - uses organization axes as step 2 of a full workflow
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Enrich content
description: >-
Apply a domain-specific lens to produce richer, more targeted analysis of your
videos.

---

This recipe shows you how to apply a domain-specific lens to your video collection and get structured, targeted analysis. The response includes per-video enrichments with domain-specific insights and tags — ready for your content pipeline or metadata system.

**Use cases**:

- **Brand analysis**: Evaluate brand messaging, audience engagement, and production quality across videos
- **Accessibility audits**: Describe visual elements for screen readers, assess caption quality, and identify audio-only content
- **Compliance reviews**: Identify claims, disclaimers, and required disclosures in video content
- **SEO metadata extraction**: Generate keywords, descriptions, titles, and topic clusters from video content

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Instructions**: Additional guidance that shapes the model's behavior for a specific domain or task. You pass it in the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a single call to the [Responses API](/v1.3/api-reference/responses/create-response) that combines three elements: a JSON schema that defines the enrichment data structure, instructions that give the model a specific role and domain guidance, and a prompt that describes what analysis you want. The model reasons across your knowledge store, finds relevant content, and returns structured results that match your schema. You can adapt this recipe to analyze content through a different domain lens.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Define a JSON schema for the enrichment results
enrichment_schema = {
    "type": "object",
    "properties": {
        "enrichments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "video_reference": {"type": "string", "description": "The plain UUID of the source video"},  # Source video identifier
                    "original_summary": {"type": "string"},    # Default summary from indexing
                    "enriched_analysis": {"type": "string"},   # Domain-specific analysis
                    "new_insights": {"type": "array", "items": {"type": "string"}},  # Domain-specific findings
                    "tags": {"type": "array", "items": {"type": "string"}}           # Domain-specific labels
                }
            }
        }
    }
}

# Step 2: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "instructions": "You are a brand strategist. Analyze videos through the lens of brand perception and marketing effectiveness.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "For each video, provide enriched analysis focusing on brand messaging effectiveness, audience engagement signals, and production quality."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "content_enrichment",
                "schema": enrichment_schema
            }
        }
    }
)

# Step 3: Parse the structured response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            data = json.loads(content["text"])
            for e in data["enrichments"]:
                print(f"\n{e['video_reference']}")
                print(f"  Analysis: {e['enriched_analysis']}")
                print(f"  Insights: {', '.join(e['new_insights'])}")
                print(f"  Tags: {', '.join(e['tags'])}")
```

# Code explanation

<Steps>
  <Step title="Define the output schema">
    Create a JSON schema that describes the enrichment data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Request enrichment analysis">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema, domain instructions, and prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `instructions`: Additional guidance that shapes the model's behavior for a specific domain or task. Maximum length: 2,000 characters. This example uses a brand strategist role focused on brand perception and marketing effectiveness.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example requests enriched analysis of brand messaging effectiveness, audience engagement signals, and production quality.
    - `knowledge_store_id`: The unique identifier of the knowledge store to use.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "enrichments": [
    {
      "video_reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a",
      "original_summary": "A 3-minute product launch video featuring a presenter demonstrating a new smartwatch with outdoor activity footage.",
      "enriched_analysis": "The video leads with aspirational outdoor imagery before transitioning to product features. Brand messaging emphasizes durability and adventure. The presenter maintains an enthusiastic but credible tone, and quick cuts between lifestyle footage and close-up product shots sustain viewer attention.",
      "new_insights": [
        "Strong brand-lifestyle alignment through outdoor activity sequences",
        "Product features presented in context of real-world use rather than specifications",
        "Call-to-action placement at 2:30 follows the engagement peak"
      ],
      "tags": [
        "brand_lifestyle",
        "product_demo",
        "aspirational_messaging",
        "strong_pacing"
      ]
    }
  ]
}
```

<Note title="Note">
The `original_summary` field is populated from the summary the platform generated when the video was indexed.
</Note>

# Variations

Change the instructions and prompt to adapt this recipe for different domains and analysis types.

- **Change the domain lens**: Set the `instructions` parameter to a different analytical perspective. The schema stays the same.
  - Accessibility: "Analyze for accessibility: describe visual elements for screen readers, note caption quality, identify audio-only content."
  - Compliance: "Review for regulatory compliance: identify claims, disclaimers, required disclosures."
  - Education: "Analyze pedagogical effectiveness: identify learning objectives, teaching methods, assessment opportunities."
  - SEO: "Extract SEO metadata: keywords, descriptions, suggested titles, topic clusters."
- **Run a comparative analysis**: Set the instructions to "Enrich by comparing each video to the collection average."
- **Find coverage gaps**: Ask "What aspects of these videos are under-documented?" to identify areas that need deeper analysis.
- **Target a specific audience**: Change the instructions to enrich for different target audiences, such as executives, students, or technical reviewers.

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/enrich_content.ipynb)

# See also

- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Configure ingestion](/v1.3/agents/guides/create-a-knowledge-store/configure-ingestion) - configure extraction at index time instead of at response time
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Track entities across videos
description: >-
Follow a subject across multiple videos and build a chronological timeline of
appearances with timestamps, locations, and context.

---

This recipe shows you how to follow a subject across multiple videos and build a chronological timeline of appearances. The response includes timestamps, video references, locations, and context for each sighting — ready for your tracking dashboard or analysis pipeline.

<Note title="Note">
Cross-video entity tracking is in private beta. Behavior and accuracy may change as the feature develops.
</Note>

**Use cases**:

- **Security investigations**: Track a person across multiple camera angles or footage sources
- **Timeline construction**: Build a chronological record of a subject's appearances
- **Content auditing**: Identify every moment where a specific entity appears in a collection

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Instructions**: Additional guidance that shapes the model's behavior for a specific domain or task. You pass it in the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a call to the [Responses API](/v1.3/api-reference/responses/create-response) that combines three elements: a JSON schema that defines the appearance data structure, instructions that give the model a specific role and domain guidance, and a prompt that describes the subject to track. The model reasons across your knowledge store and returns structured tracking results. You can then continue the conversation using the session identifier from the response. For example, drill into a specific appearance or ask about the surrounding context. You can adapt this recipe to track different subjects or focus on different appearance details.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Define a JSON schema for the tracking timeline
tracking_schema = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},              # Description of the tracked subject
        "timeline": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "timestamp": {"type": "string"},        # When the appearance occurs
                    "video_reference": {"type": "string"},  # Source video identifier
                    "location": {"type": "string"},         # Where in the scene
                    "action": {"type": "string"}            # What the subject is doing
                }
            }
        },
        "summary": {"type": "string"}               # Overall tracking summary
    }
}

# Step 2: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "instructions": "You are a security analyst. Prioritize temporal accuracy. Flag any low-confidence identifications.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Track the person in the blue hoodie across all cameras. Give me a chronological timeline."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "entity_tracking",
                "schema": tracking_schema
            }
        }
    }
)

# Step 3: Parse the structured response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            data = json.loads(content["text"])
            print(f"Subject: {data['subject']}")
            print(f"Summary: {data['summary']}\n")
            for entry in data["timeline"]:
                print(f"  [{entry['timestamp']}] {entry['video_reference']}")
                print(f"    Location: {entry['location']}")
                print(f"    Action: {entry['action']}")

# Step 4: Refine with a follow-up turn
follow_up = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "session_id": result["session_id"],
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Tell me more about what happened at the third timestamp. What was happening around the subject?"
            }
        ],
        "knowledge_store_id": STORE_ID
    }
)

# Step 5: Print the follow-up response
follow_up_result = follow_up.json()
for output in follow_up_result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            print(content["text"])
```

# Code explanation

<Steps>
  <Step title="Define the output schema">
    Create a JSON schema that describes the tracking data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Request a tracking timeline">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema, tracking instructions, and prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `instructions`: Additional guidance that shapes the model's behavior for a specific domain or task. Maximum length: 2,000 characters. This example uses a security analyst role that prioritizes temporal accuracy.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example describes the subject to track and requests a chronological timeline.
    - `knowledge_store_id`: The unique identifier of the knowledge store to search.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

        <Tip>Describe your subject with specific physical details — clothing, features, and distinguishing characteristics improve tracking accuracy.</Tip>

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
  <Step title="Refine with a follow-up turn">
    Use the `session_id` field from the first response to continue the conversation. The model retains the full context from the previous turn, so you can drill into specific appearances without repeating the original prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `session_id`: The session identifier from the previous response. Continues the existing conversation.
    - `input`: An array of input items. The `content` field contains your follow-up prompt. This example asks for more detail about a specific timestamp from the timeline.
    - `knowledge_store_id`: The unique identifier of the knowledge store. Must match the knowledge store from the original request.

    **Return value**: A response object with the same structure as the first response. This follow-up does not use the `text.format` parameter, so the `text` field in each content part contains plain text instead of JSON.

  </Step>
  <Step title="Print the follow-up response">
    The follow-up response uses the same output structure as the first response. Because this request does not include a schema, the `text` field contains plain text. This example prints it directly.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "subject": "Person in blue hoodie",
  "timeline": [
    {
      "timestamp": "02:15-03:40",
      "video_reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a",
      "location": "Building lobby, near the front entrance",
      "action": "Enters through the main door and walks toward the elevator"
    },
    {
      "timestamp": "05:42-06:10",
      "video_reference": "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c",
      "location": "Third floor hallway",
      "action": "Exits the elevator and walks down the corridor"
    }
  ],
  "summary": "Subject appears in 2 videos over a 3-minute span, moving from the lobby to the third floor."
}
```

<Note title="Notes">
- The `video_reference` field contains the asset identifier of the knowledge store item.
- The `timestamp` field is a range in `MM:SS-MM:SS` format indicating when the appearance starts and ends.
- If the model cannot find the subject in the collection — for example, because the footage does not contain a match or the subject description is ambiguous — it returns an empty array named `timeline` and explains the result in the `summary` field.
- The model identifies subjects visually and does not match by voice.
- Each request tracks one subject. To track multiple subjects, make separate requests.
- Tracking accuracy depends on video quality, camera angles, lighting, and how distinctive the subject appears.
</Note>

# Variations

Change the instructions and prompt to adapt this recipe for different tracking scenarios.

- **Change the analytical perspective**: Set the `instructions` parameter to "documentary researcher" or "video editor" for different emphasis.
- **Track objects instead of people**: Change the prompt to track a vehicle, branded object, or recurring visual element.
- **Multi-episode tracking**: Track a recurring character or subject across an episode series.

# See also

- [Extract entities](/v1.3/agents/recipes/extract-entities) - list all entities before deciding which to track
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions) - more on continuing conversations
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Organize a video library
description: >-
Discover the contents of a video collection, find the best organization
strategy, and categorize every video in a multi-turn session.

---

This recipe shows you how to organize an entire video library in a multi-turn session. The final output is a complete library catalog as structured JSON — every video assigned to a group, ready for your CMS or DAM system.

**Use cases**:

- **Library management**: Categorize a new or growing video collection
- **Content audit**: Discover natural groupings before restructuring a library
- **Pipeline automation**: Generate a machine-readable catalog for a CMS or DAM system

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Multi-turn session**: A conversation where each request builds on previous turns. The first request creates a session and returns a `session_id` value. Pass this value in follow-up requests to continue the conversation. For details, see the [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions) page.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make three calls to the [Responses API](/v1.3/api-reference/responses/create-response) in a single session. The first call requests a plain-text overview of the collection. The second call passes a JSON schema and asks the model to discover and rank categorization strategies. The third call takes the top-ranked strategy and categorizes every video. Each call builds on the context of previous turns, so the model refines its analysis as the session progresses. You can adapt this recipe to organize by different criteria or target a specific domain.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.
- For best results, use a knowledge store with 10 or more videos.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Request a collection overview
print("Step 1: Understanding your collection...")
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Give me a high-level overview of this video collection. What themes, subjects, and patterns do you see?"
            }
        ],
        "knowledge_store_id": STORE_ID
    }
)
result = response.json()

# Step 2: Print the overview and store the session ID
session_id = result["session_id"]
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            print(content["text"])

# Step 3: Define the organization axes schema
axes_schema = {
    "type": "object",
    "properties": {
        "recommended_axes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "axis": {"type": "string"},                  # Name of the categorization dimension
                    "reason": {"type": "string"},                # Why this axis works well
                    "expected_categories": {                      # Sample category names
                        "type": "array",
                        "items": {"type": "string"}
                    },
                    "score": {"type": "number"}                  # 0-1 effectiveness score
                }
            }
        },
        "best_axis": {"type": "string"},                         # Top-ranked axis name
        "reasoning": {"type": "string"}                          # Overall recommendation rationale
    }
}

# Step 4: Discover organization strategies
print("\nStep 4: Finding best organization strategy...")
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "session_id": session_id,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "What are the best ways to organize this collection? Rank the top 3 axes by how well they'd separate the content into useful groups."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "organization_axes",
                "schema": axes_schema
            }
        }
    }
)
result = response.json()

# Step 5: Parse the organization strategies
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            axes = json.loads(content["text"])
            print(f"Best axis: {axes['best_axis']}")
            print(f"Reasoning: {axes['reasoning']}")
            for ax in axes["recommended_axes"]:
                print(f"  {ax['axis']} (score: {ax['score']}): {ax['reason']}")

# Step 6: Define the catalog schema
catalog_schema = {
    "type": "object",
    "properties": {
        "organization_axis": {"type": "string"},             # The axis used for categorization
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},              # Category name
                    "description": {"type": "string"},       # What this category contains
                    "videos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "reference": {"type": "string"},  # Source video identifier
                                "title": {"type": "string"},      # Video title
                                "summary": {"type": "string"}     # Brief description
                            }
                        }
                    }
                }
            }
        },
        "total_videos": {"type": "integer"}                  # Total number of videos categorized
    }
}

# Step 7: Categorize videos
print(f"\nStep 7: Organizing by '{axes['best_axis']}'...")
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "session_id": session_id,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": f"Now organize every video by '{axes['best_axis']}'. Include all videos."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "video_catalog",
                "schema": catalog_schema
            }
        }
    }
)

# Step 8: Parse the response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            catalog = json.loads(content["text"])
            print(f"\nLibrary Catalog ({catalog['total_videos']} videos)")
            print(f"Organized by: {catalog['organization_axis']}")
            for cat in catalog["categories"]:
                print(f"\n  [{cat['name']}] - {cat['description']}")
                for v in cat["videos"]:
                    print(f"    {v['title']}: {v['summary']}")
```

# Code explanation

<Steps>
  <Step title="Request a collection overview">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with a prompt requesting a high-level overview. This first request creates a session.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example requests a high-level overview of themes, subjects, and patterns in the collection.
    - `knowledge_store_id`: The unique identifier of the knowledge store to use.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier for this conversation. Pass this value in follow-up requests to continue the multi-turn session.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Print the overview and store the session ID">
    Each output item with `type: "message"` contains an array named `content`. The `text` field in each content part contains the model's plain-text overview. Store the `session_id` value from the response — all follow-up requests use it to continue the session.

    The overview text also establishes the session context. The model retains this analysis automatically, so the organization recommendations in step 4 are grounded in the collection overview from this step.

  </Step>
  <Step title="Define the organization axes schema">
    Create a JSON schema that describes the axis data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Discover organization strategies">
    Continue the session with a prompt that asks the model to rank categorization strategies. The model uses the collection context from the previous turn to inform its recommendations.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `session_id`: The session identifier for a multi-turn conversation. Pass the value returned from a previous response to continue that conversation. This example uses the identifier from step 1.
    - `input`: An array of input items. This example asks the model to rank the top three categorization strategies by effectiveness.
    - `knowledge_store_id`: The unique identifier of the knowledge store. Must match the store used to create the session.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object with the same structure as step 1. When you request structured output, the `text` field in each content part is a JSON string that matches your schema.

  </Step>
  <Step title="Parse the organization strategies">
    Each output item with `type: "message"` contains an array named `content`. Parse the JSON string in the `text` field with `json.loads()` to get a Python dictionary. Extract the `best_axis` value — step 7 uses it to categorize videos along that dimension.
  </Step>
  <Step title="Define the catalog schema">
    Create a JSON schema that describes the catalog data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Categorize videos">
    Continue the session with a prompt that requests categorization.

    **Parameters**: Same as step 4, with two differences:
    - `input`: This example dynamically inserts the `best_axis` value from step 5 into the prompt, instructing the model to organize every video by the top-ranked axis.
    - `text.format`: Uses the catalog schema to structure the categorized results.

    **Return value**: A response object with the same structure as step 1. The `text` field in each content part is a JSON string that matches your catalog schema.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result from the final categorization step looks like this:

```json
{
  "organization_axis": "Content Type",
  "categories": [
    {
      "name": "Tutorials",
      "description": "Step-by-step instructional videos covering product features",
      "videos": [
        {
          "reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a",
          "title": "Getting Started with the Dashboard",
          "summary": "Walks through initial setup, navigation, and key workflows"
        },
        {
          "reference": "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c",
          "title": "API Integration Tutorial",
          "summary": "Covers authentication, first API call, and error handling"
        }
      ]
    },
    {
      "name": "Product Demos",
      "description": "Feature demonstrations and product showcases",
      "videos": [
        {
          "reference": "069ea183-ed43-7d69-8000-e2e3ab3ea1d1",
          "title": "Analytics Dashboard Demo",
          "summary": "Live walkthrough of the analytics dashboard and reporting tools"
        }
      ]
    }
  ],
  "total_videos": 12
}
```

<Note title="Notes">
- The `reference` field in each video entry contains the asset identifier of the knowledge store item.
- The `title` field is generated by the model from the content of the video — it is not taken from a filename or metadata field.
- The model evaluates the actual content in your knowledge store. Results change depending on the videos you have indexed.
</Note>

# Variations

Change the prompts or add the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter to adapt this recipe for different organizational needs.

- **Multi-axis catalog**: Run step 7 multiple times with different axes from step 5 to produce catalogs along different dimensions.
- **Hierarchical organization**: After the first categorization, send a follow-up prompt: "Now sub-organize the [category] group by difficulty level."
- **Export**: Pipe the JSON output to a file for use in your CMS or DAM system.
- **Known criteria**: Skip the discovery steps and send a single request. Set the `instructions` parameter to a librarian role (for example, "You are a content librarian. Organize videos into clear, mutually exclusive categories.") and specify the categories directly in the prompt.

  Example:

  | Criteria    | Prompt                                                           |
  | ----------- | ---------------------------------------------------------------- |
  | By topic    | "Organize by main subject matter"                                |
  | By mood     | "Organize by emotional tone: upbeat, serious, neutral"           |
  | By audience | "Organize by target audience: beginners, intermediate, advanced" |
  | By format   | "Organize by format: tutorial, interview, demo, vlog"            |
  | By speaker  | "Group videos by who appears on screen"                          |

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/organize_video_library.ipynb)

# See also

- [Generate a corpus overview](/v1.3/agents/recipes/get-a-corpus-overview) - the standalone version of steps 1–2
- [Find organization axes](/v1.3/agents/recipes/find-organization-axes) - the standalone version of steps 3–5
- [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions) - more on session-based conversations
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Assemble highlight reels
description: >-
Find and sequence relevant clips from a video collection based on a theme,
topic, or criteria.

---

This recipe shows you how to find and sequence clips from a video collection based on a theme, topic, or set of criteria. The response includes clip references with video identifiers, timestamps, and assembly notes — ready for your editing tool or pipeline.

**Use cases**:

- **Marketing highlight reels**: Select product demos and customer reactions for promotional videos
- **Event recaps**: Pull the best moments from conference or event footage
- **Training compilations**: Assemble instructional clips by topic or skill level
- **Content repurposing**: Find and sequence clips for social media or internal communications

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Instructions**: Additional guidance that shapes the model's behavior for a specific domain or task. You pass it in the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.

# Workflow

You make a single call to the [Responses API](/v1.3/api-reference/responses/create-response) that combines three elements: a JSON schema that defines the clip data structure, instructions that give the model a specific role and domain guidance, and a prompt that describes what you want in the highlight reel. The model reasons across your knowledge store, finds the best matching moments, and returns structured clip references in the order it recommends. You can adapt this recipe to target different editorial styles or content themes.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}
STORE_ID = "<YOUR_KNOWLEDGE_STORE_ID>"

# Step 1: Define a JSON schema for the clip references
clip_schema = {
    "type": "object",
    "properties": {
        "assembly_title": {"type": "string"},            # Title for the highlight reel
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "video_reference": {"type": "string"},   # Source video identifier
                    "start_time": {"type": "string"},        # Clip start timestamp
                    "end_time": {"type": "string"},          # Clip end timestamp
                    "description": {"type": "string"},       # What happens in the clip
                    "relevance_reason": {"type": "string"}   # Why the model selected this clip
                }
            }
        },
        "total_estimated_duration": {"type": "string"},  # Combined duration of all clips
        "assembly_notes": {"type": "string"}             # Sequencing and editorial guidance
    }
}

# Step 2: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "instructions": "You are a video editor assembling a highlight reel. Select clips that flow well together with good pacing and variety.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Find the best clips showing product demos and customer reactions. I need a 2-minute highlight reel."
            }
        ],
        "knowledge_store_id": STORE_ID,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "highlight_reel",
                "schema": clip_schema
            }
        }
    }
)

# Step 3: Parse the structured response
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            assembly = json.loads(content["text"])
            print(f"Assembly: {assembly['assembly_title']}")
            print(f"Duration: {assembly['total_estimated_duration']}")
            print(f"Notes: {assembly['assembly_notes']}")
            for i, clip in enumerate(assembly["clips"], 1):
                print(f"  {i}. [{clip['start_time']}-{clip['end_time']}] {clip['description']}")
                print(f"     Why: {clip['relevance_reason']}")
```

# Code explanation

<Steps>
  <Step title="Define the output schema">
    Create a JSON schema that describes the clip data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Request clip selections">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema, editorial instructions, and prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `instructions`: Additional guidance that shapes the model's behavior for a specific domain or task. Maximum length: 2,000 characters. This example uses a video editor role that prioritizes pacing and variety.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example describes the desired highlight reel — what clips to find, how long the reel should be, and the thematic criteria.
    - `knowledge_store_id`: The unique identifier of the knowledge store to use.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary.
  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "assembly_title": "Product Demo Highlights Q1",
  "clips": [
    {
      "video_reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a",
      "start_time": "01:22",
      "end_time": "01:45",
      "description": "Close-up product walkthrough with feature callouts",
      "relevance_reason": "Strong visual demonstration of core feature"
    },
    {
      "video_reference": "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c",
      "start_time": "03:10",
      "end_time": "03:38",
      "description": "Customer describing their positive experience",
      "relevance_reason": "Authentic testimonial with emotional impact"
    }
  ],
  "total_estimated_duration": "01:51",
  "assembly_notes": "Opens with product demo for context, transitions to customer reactions for social proof"
}
```

<Note title="Notes">
- The `video_reference` field contains the asset identifier of the knowledge store item.
- The `start_time` and `end_time` fields use `MM:SS` format for videos under one hour and `HH:MM:SS` for longer content.
- The model returns clip references (video identifiers and timestamps), not rendered video files. Use these references with your video editing tool or pipeline to assemble the final reel.
</Note>

# Variations

Change the instructions and prompt to adapt this recipe for different editorial styles and content focuses.

- **Change the editorial style**: Set the `instructions` parameter to "documentary editor", "social media creator", or "training video producer."
- **Change the content focus**: Change the prompt to request "funny moments", "technical deep dives", or "executive summaries."
- **Refine with follow-up turns**: Use a [multi-turn session](/v1.3/agents/guides/create-a-response/multi-turn-sessions) to adjust the results: "Replace the second clip with something more energetic."

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/assemble_highlight_reels.ipynb)

# See also

- [Search videos](/v1.3/agents/recipes/search-videos) - the single-step version of clip search
- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Build a content agent
description: >-
Build a multi-step agent that produces structured creative output from video
footage using domain-specific ingestion, instructions, and multi-turn
refinement.

---

This recipe shows you how to build a multi-step agent that analyzes a video collection and produces structured creative output. The example constructs a micro-drama outline with scene breakdowns, character arcs, and clip references.

**Use cases**:

- **Micro-drama outlines**: Extract narrative elements and construct scene breakdowns from video footage
- **Training curricula**: Identify learning objectives and demonstrations for instructional design
- **Compliance audits**: Find claims, disclosures, and regulation references for review
- **Content plans**: Discover topics, audience signals, and gaps for editorial strategy

# Key concepts

- **Knowledge store**: A persistent store of your videos plus the understanding the platform derives from them — spatiotemporal context, a typed ontology, and embeddings — that together enable corpus-level reasoning.
- **Ingestion config**: A configuration that controls how the platform processes content added to a knowledge store. You set the [`ingestion_config`](/v1.3/api-reference/knowledge-stores/create-knowledge-store#request.body.ingestion_config) parameter at creation time and cannot change it afterward.
- **Instructions**: Additional guidance that shapes the model's behavior for a specific domain or task. You pass it in the [`instructions`](/v1.3/api-reference/responses/create-response#request.body.instructions) parameter.
- **Structured output**: A JSON schema you pass in the [`text.format`](/v1.3/api-reference/responses/create-response#request.body.text) parameter. The model constrains its output to match your schema, so you retrieve machine-readable results instead of plain text. For a guide on designing schemas and parsing responses, see the [Structured output](/v1.3/agents/guides/create-a-response/structured-output) page.
- **Multi-turn session**: A conversation where each request builds on previous turns. The first request creates a session and returns a `session_id` value. Pass this value in follow-up requests to continue the conversation. For details, see the [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions) page.

# Workflow

This recipe combines three capabilities into a reusable agent pattern. First, you create a knowledge store with a domain-specific ingestion config. This config controls what the platform extracts from your videos during processing. Then, you call the [Responses API](/v1.3/api-reference/responses/create-response) with a JSON schema, instructions that give the model a specific role and domain guidance, and a prompt. The model reasons across your knowledge store and returns structured output that matches your schema. Finally, you use the session ID to refine the results in a follow-up turn. You can adapt this pattern to any creative or analytical domain.

# Prerequisites

- You've already created a knowledge store with at least one item in `ready` status. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for details.
- You're familiar with the request and response format. See the [Create a response](/v1.3/agents/guides/create-a-response) page for details.

# Complete example

Copy and paste the code below, replacing the placeholders surrounded by `<>` with your values.

```python

API_KEY = "<YOUR_API_KEY>"
BASE_URL = "https://api.twelvelabs.io/v1.3"
HEADERS = {"x-api-key": API_KEY, "Content-Type": "application/json"}

# Step 1: Create a knowledge store with a domain-specific ingestion config
response = requests.post(
    f"{BASE_URL}/knowledge-stores",
    headers=HEADERS,
    json={
        "name": "Microdrama Source Material",
        "ingestion_config": {
            "enrichment_config": {
                "type": "description",
                "description": "Focus on characters and their emotions, interpersonal dynamics, conflicts, tension points, visual mood shifts, dialogue tone, and dramatic turning points. Track recurring characters across videos."
            }
        }
    }
)
store_id = response.json()["_id"]

# Before continuing, add video assets to your knowledge store and wait
# for processing to complete. See the Quickstart for details.

# Step 2: Define a JSON schema for the narrative output
drama_schema = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},                # Title for the micro-drama
        "logline": {"type": "string"},               # One-sentence summary
        "characters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},      # Character name
                    "role": {"type": "string"},      # Protagonist, antagonist, etc.
                    "arc": {"type": "string"}        # Character development summary
                }
            }
        },
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scene_number": {"type": "integer"},     # Position in sequence
                    "description": {"type": "string"},       # What happens in the scene
                    "video_reference": {"type": "string"},   # Source video identifier
                    "timestamp": {"type": "string"},         # Clip timestamp
                    "dramatic_function": {"type": "string"}  # Role in the narrative arc
                }
            }
        },
        "central_conflict": {"type": "string"},      # Main dramatic tension
        "resolution": {"type": "string"}             # How the conflict resolves
    }
}

# Step 3: Send the request to the Responses API
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "instructions": "You are a micro-drama creator. Analyze the video collection for narrative potential. Identify characters, conflicts, and dramatic moments. Construct a compelling 60-second micro-drama outline.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Create a micro-drama from these videos. Focus on the strongest emotional arc you can find."
            }
        ],
        "knowledge_store_id": store_id,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "micro_drama",
                "schema": drama_schema
            }
        }
    }
)

# Step 4: Process the response
result = response.json()
session_id = result["session_id"]
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            drama = json.loads(content["text"])
            print(f"Title: {drama['title']}")
            print(f"Logline: {drama['logline']}")
            print(f"Conflict: {drama['central_conflict']}")
            for scene in drama["scenes"]:
                print(f"  Scene {scene['scene_number']}: {scene['description']}")

# Step 5: Refine the output in a follow-up turn
response = requests.post(
    f"{BASE_URL}/responses",
    headers=HEADERS,
    json={
        "model": "jockey1.0",
        "session_id": session_id,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": "Make the conflict sharper. Can you find a stronger turning point moment?"
            }
        ],
        "knowledge_store_id": store_id,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "micro_drama",
                "schema": drama_schema
            }
        }
    }
)

# Process the refined output
result = response.json()
for output in result["output"]:
    if output["type"] == "message":
        for content in output["content"]:
            drama = json.loads(content["text"])
            print(f"\nRefined Title: {drama['title']}")
            print(f"Logline: {drama['logline']}")
            print(f"Conflict: {drama['central_conflict']}")
            for scene in drama["scenes"]:
                print(f"  Scene {scene['scene_number']}: {scene['description']}")
```

# Code explanation

<Steps>
  <Step title="Create a domain-focused knowledge store">
    Call the [`POST /knowledge-stores`](/v1.3/api-reference/knowledge-stores/create-knowledge-store) endpoint to create a knowledge store with an ingestion config tailored to your domain.

    **Parameters**:
    - `name`: The name of the knowledge store.
    - `ingestion_config`: A configuration that controls how the platform processes content added to this knowledge store. You cannot change this configuration after creation. Contains an object named `enrichment_config` with the following properties:
      - `type`: The enrichment type. Set to `"description"` to provide a natural-language description of what to extract. You can also set this to `"json_schema"` for precise control over the extracted fields. For details, see the [Configure ingestion](/v1.3/agents/guides/create-a-knowledge-store/configure-ingestion) page.
      - `description`: A natural-language description of the knowledge to extract from videos. This example focuses on narrative elements — characters, emotions, conflicts, and dramatic turning points.

    **Return value**: A response object containing, among other information, the following fields:
    - `_id`: The unique identifier of the knowledge store. Pass this value in subsequent API calls.

    After creating the store, add video assets and wait for processing to complete. See the [Quickstart](/v1.3/agents/get-started/quickstart) page for the full upload and processing workflow.

  </Step>
  <Step title="Define the output schema">
    Create a JSON schema that describes the narrative data you want back. The schema is yours to design — add or remove fields to match your use case. See the inline comments in the complete example for a description of each field.
  </Step>
  <Step title="Request a narrative outline">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint with your schema, domain instructions, and prompt.

    **Parameters**:
    - `model`: The model to use. Must be `jockey1.0`.
    - `instructions`: Additional guidance that shapes the model's behavior for a specific domain or task. Maximum length: 2,000 characters. This example uses a micro-drama creator role that identifies narrative elements.
    - `input`: An array of input items. The `content` field contains your natural-language prompt. This example asks the model to create a micro-drama, focusing on the strongest emotional arc.
    - `knowledge_store_id`: The unique identifier of the knowledge store to use.
    - `text.format`: The output format. Set the `type` field to `json_schema`, use the `name` field to identify the schema, and pass your schema object in the `schema` field.

    **Return value**: A response object containing, among other information, the following fields:
    - `id`: A unique identifier for this response.
    - `knowledge_store_id`: The knowledge store this response was generated against.
    - `session_id`: The session identifier. Pass this value in a follow-up request to continue the conversation.
    - `status`: The status of the response. The possible values are `completed`, `failed`, `in_progress`, and `incomplete`.
    - `output`: The response output items. Each item with `type: "message"` contains the model's reply.
    - `usage`: Token usage statistics, including the `input_tokens` and `output_tokens` fields.

  </Step>
  <Step title="Parse the response">
    Each output item with `type: "message"` contains an array named `content`. When you request structured output, the `text` field in each content part is a JSON string that matches your schema. Parse it with `json.loads()` to get a Python dictionary. This step also saves the `session_id` value for the next step.
  </Step>
  <Step title="Refine the output in a follow-up turn">
    Call the [`POST /responses`](/v1.3/api-reference/responses/create-response) endpoint again, this time passing the `session_id` value from the previous response.

    **Parameters**:
    - `session_id`: The session identifier returned from the previous response. The model retains the context from earlier turns.
    - `input`: A new prompt that describes how to refine the output. This example asks the model to sharpen the conflict and find a stronger turning point.
    - The remaining parameters (`model`, `knowledge_store_id`, `text.format`) match Step 3.

    **Return value**: Same structure as Step 3. Parse the output the same way.

  </Step>
</Steps>

# Example response

The `text` field inside each content part is a JSON string that matches your schema. After parsing, a typical result looks like this:

```json
{
  "title": "The Unspoken Divide",
  "logline": "Two colleagues navigate a silent rivalry that threatens to unravel their shared project.",
  "characters": [
    {
      "name": "Maya",
      "role": "Protagonist",
      "arc": "Moves from passive avoidance to direct confrontation"
    },
    {
      "name": "Daniel",
      "role": "Antagonist",
      "arc": "Shifts from confident control to vulnerability when challenged"
    }
  ],
  "scenes": [
    {
      "scene_number": 1,
      "description": "Maya and Daniel present their project update, tension visible in their body language",
      "video_reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a",
      "timestamp": "02:15-02:42",
      "dramatic_function": "Establishes the core tension between the two characters"
    },
    {
      "scene_number": 2,
      "description": "Maya reviews documents alone, frustration building as she discovers discrepancies",
      "video_reference": "069e1e97-27f8-7a8e-8000-bf32ecd7fc8c",
      "timestamp": "08:30-08:55",
      "dramatic_function": "Rising action - reveals the source of the conflict"
    },
    {
      "scene_number": 3,
      "description": "Maya confronts Daniel in the hallway, his composure breaks",
      "video_reference": "069eb4e8-aeb0-7e83-8000-86413fcc296a",
      "timestamp": "14:02-14:28",
      "dramatic_function": "Climax - the unspoken divide becomes spoken"
    }
  ],
  "central_conflict": "Maya suspects Daniel has been taking credit for her contributions, but neither acknowledges it directly",
  "resolution": "Maya presents her work independently, forcing a public acknowledgment of her contributions"
}
```

<Note title="Notes">
- The `video_reference` field contains the asset identifier of the knowledge store item.
- The `timestamp` field is a range in `MM:SS-MM:SS` format indicating the clip boundaries.
- The model returns narrative outlines with clip references (video identifiers and timestamps), not rendered video files. Use these references with your editing tool or pipeline to assemble the final content.
</Note>

# Variations

Change the ingestion config, instructions, or prompt to adapt this pattern for different domains and creative directions.

- **Change the genre**: Set the `instructions` parameter to "horror micro-drama creator", "comedy sketch writer", or "documentary short producer."
- **Focus on a character**: Change the prompt to "Build the drama around the most frequently appearing person."
- **Create a series**: Use a [multi-turn session](/v1.3/agents/guides/create-a-response/multi-turn-sessions) to extend the story: "Create episode 2, continuing from this ending."
- **Change the domain**: Replace the ingestion config, instructions, and schema to build a training curriculum designer, compliance auditor, or content planner.

# Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/recipes/build_content_agent.ipynb)

# See also

- [Structured output](/v1.3/agents/guides/create-a-response/structured-output) - more on JSON Schema responses
- [Multi-turn sessions](/v1.3/agents/guides/create-a-response/multi-turn-sessions) - more on session-based conversations
- [Configure ingestion](/v1.3/agents/guides/create-a-knowledge-store/configure-ingestion) - control what the platform extracts during processing
- [Create a response](/v1.3/api-reference/responses/create-response) - API reference for the Responses endpoint

---

title: Jockey
description: >-
Jockey is a unified multimodal model that reasons across video collections and
generates responses.

---

Jockey is a unified multimodal model that reasons across video collections. The current version is **Jockey 1.0**.

# Key features

- **Unified multimodal reasoning**: Processes all modalities automatically.
- **Natural-language instructions**: Describe what you want in natural language instead of selecting which modalities to use.
- **Corpus-level analysis**: Reasons across every item in a knowledge store to answer questions.
- **Multi-turn sessions**: Maintains conversation context across follow-up requests.
- **Structured output**: Returns typed JSON responses when you provide a JSON Schema.
- **Domain-specific behavior**: Uses instructions to adapt responses for specific domains, including but not limited to editorial review, compliance, education, or security.

# Use cases

- **Corpus overview**: Generate responses that reason across your entire video collection
- **Search and discovery**: Find moments across videos by describing what you want in natural language
- **Entity extraction**: Identify people, places, objects, and other entities across a knowledge store
- **Content organization**: Categorize videos by themes, topics, formats, or other useful dimensions
- **Cross-video tracking**: Track a subject across multiple videos and reconstruct a timeline of appearances
- **Content assembly**: Identify and sequence specific moments into highlight reels or compilations
- **Content enrichment**: Analyze existing content through a specific domain lens or schema

# Input requirements

The specifications on this page reflect the maximum capabilities of the model. Your actual requirements also depend on the upload method you choose. For details about the available upload methods and the corresponding limits, see the [Upload content](/v1.3/agents/guides/upload-content) page.

## Video file requirements

- **File size**: ≤ 2 GB
- **Resolution**: 360x360 to 5184x2160
- **Aspect ratio**: Between 1:1 and 1:2.4, or between 2.4:1 and 1:1. For example, you can use 1:1, 4:3, 4:5, 5:4, 16:9, 9:16, or 17:9.
- **Formats**: [FFmpeg supported](https://ffmpeg.org/ffmpeg-formats.html)

<Note title="Notes">
- If you upload files using publicly accessible URLs, use direct links to raw video files that play without user interaction or custom video players (example: `https://example.com/videos/sample-video.mp4`). Video hosting platforms like YouTube and cloud storage sharing links are not supported.
 
- For videos in other formats or if you require different options, contact us at support@twelvelabs.io.
</Note>

# Support

For support or feedback regarding Jockey, contact [support@twelvelabs.io](mailto:support@twelvelabs.io).

# Assets

An asset is a video file that you upload to the platform. Each asset has a unique identifier that you can reference across multiple knowledge stores. Once uploaded, you can add the same asset to multiple knowledge stores - for example, to analyze the same content with different ingestion configurations.

To upload assets, see the [Upload content](/v1.3/agents/guides/upload-content) guide.

## Lifecycle

After upload, the platform processes the asset before it can be used:

| Status       | Meaning                                       |
| ------------ | --------------------------------------------- |
| `processing` | Upload received, processing in progress       |
| `ready`      | Available to add to a knowledge store         |
| `failed`     | Processing failed - check the error and retry |

An asset must reach `ready` status before you can add it to a knowledge store.

## Reusability

Assets exist independently of knowledge stores. Once uploaded, you can add the same asset to multiple knowledge stores - for example, to analyze the same content with different ingestion configurations.

# Knowledge stores

A knowledge store is a persistent, queryable store of your videos plus the understanding the platform derives from them. It contains three layers:

- **Spatiotemporal context**: entities, moments, facts, and summaries extracted from your videos
- **Typed ontology**: a schema that organizes those elements and their relationships
- **Embeddings**: vector representations that make the content semantically retrievable

Together these layers form the substrate for corpus-level reasoning: the platform reasons across the full collection, not just individual clips.

## Ingestion configuration

The ingestion config controls what the platform extracts from your videos. Set it when you create a knowledge store.

For the available approaches and guidance on choosing one, see the [Configure ingestion](/v1.3/agents/guides/create-a-knowledge-store/configure-ingestion) guide.

## Knowledge store items

A knowledge store item is an asset added to a knowledge store for indexing. Items are processed asynchronously.

```
Add asset → queued → pending → processing → ready
                                          → failed
```

| Status       | Meaning                    | Action                             |
| ------------ | -------------------------- | ---------------------------------- |
| `queued`     | Waiting to be processed    | Poll and wait                      |
| `pending`    | About to start processing  | Poll and wait                      |
| `processing` | Indexing in progress       | Poll and wait                      |
| `ready`      | Item indexed and queryable | Proceed to query                   |
| `failed`     | Indexing failed            | Check error, retry with a new item |

All items must reach `ready` status before the knowledge store can return meaningful query results. Each query targets a single knowledge store - you cannot query across stores.

## Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/guides/building_knowledge_stores.ipynb)

## API reference

- [POST /knowledge-stores](/v1.3/api-reference/knowledge-stores/create-knowledge-store) - create a knowledge store
- [GET /knowledge-stores/{id}](/v1.3/api-reference/knowledge-stores/retrieve-knowledge-store) - retrieve a knowledge store
- [POST /knowledge-stores/{id}/items](/v1.3/api-reference/knowledge-store-items/add-item) - add an item
- [GET /knowledge-stores/{id}/items/{item_id}](/v1.3/api-reference/knowledge-store-items/retrieve-item) - check item status

# Error Handling

How to handle errors across the Jockey API.

## Error Response Format

All errors follow the same shape:

```json
{
  "code": "invalid_request",
  "message": "The 'method' field is required",
  "docs_url": "https://docs.twelvelabs.io/errors/invalid_request"
}
```

## HTTP Status Codes

| Code  | Meaning      | Action                                          |
| ----- | ------------ | ----------------------------------------------- |
| `200` | Success      | Process response                                |
| `201` | Created      | Resource created successfully                   |
| `202` | Accepted     | Async operation started (knowledge store items) |
| `400` | Bad Request  | Fix request parameters                          |
| `401` | Unauthorized | Check API key                                   |
| `403` | Forbidden    | Check permissions                               |
| `404` | Not Found    | Check resource ID                               |
| `429` | Rate Limited | Back off and retry                              |
| `500` | Server Error | Retry with backoff                              |

## Retry Strategy

```python

def api_request(method, url, headers, **kwargs):
    """Make an API request with exponential backoff retry."""
    max_retries = 3
    base_delay = 1

    for attempt in range(max_retries):
        response = requests.request(method, url, headers=headers, **kwargs)

        if response.status_code == 429:
            delay = base_delay * (2 ** attempt)
            print(f"Rate limited, retrying in {delay}s...")
            time.sleep(delay)
            continue

        if response.status_code >= 500:
            delay = base_delay * (2 ** attempt)
            print(f"Server error, retrying in {delay}s...")
            time.sleep(delay)
            continue

        return response

    return response  # Return last response after all retries
```

## Common Errors by Endpoint

### Assets

| Error             | Cause                 | Fix                                       |
| ----------------- | --------------------- | ----------------------------------------- |
| `method` required | Missing upload method | Add `method: "direct"` or `method: "url"` |
| File too large    | Direct upload > 200MB | Use URL upload method instead             |
| Invalid URL       | URL not accessible    | Check URL is public and reachable         |

### Knowledge Stores

| Error          | Cause                               | Fix                                        |
| -------------- | ----------------------------------- | ------------------------------------------ |
| Invalid schema | Bad JSON Schema in ingestion config | Validate against JSON Schema draft 2020-12 |
| Name required  | Missing `name` field                | Add a name                                 |

### Knowledge Store Items

| Error           | Cause                        | Fix                               |
| --------------- | ---------------------------- | --------------------------------- |
| Asset not found | Invalid `asset_id`           | Check asset exists and is `ready` |
| Store not found | Invalid `knowledge_store_id` | Check knowledge store ID          |

### Responses

| Error                    | Cause                        | Fix                                          |
| ------------------------ | ---------------------------- | -------------------------------------------- |
| Knowledge store required | Missing `knowledge_store_id` | Add `knowledge_store_id` to the request body |
| Invalid session          | Bad `session_id`             | Start a new session (omit session_id)        |
| Input required           | Missing `input` array        | Add at least one message                     |

## Polling and Async Status

Jockey processes content asynchronously. Any time you create an asset or add a video to a knowledge store, processing happens in the background. You must poll for completion before proceeding.

### Polling Helper

```python

def wait_for_ready(url, headers, interval=5, timeout=600):
    """Poll a resource until ready or failed."""
    elapsed = 0
    while elapsed < timeout:
        response = requests.get(url, headers=headers)
        resource = response.json()
        status = resource["status"]

        if status == "ready":
            return resource
        elif status == "failed":
            raise Exception(f"Resource failed: {resource}")

        print(f"  Status: {status} ({elapsed}s elapsed)")
        time.sleep(interval)
        elapsed += interval

    raise TimeoutError(f"Not ready after {timeout}s")
```

### Usage

```python
BASE_URL = "https://api.twelvelabs.io/v1.3"

# Wait for asset
asset = wait_for_ready(f"{BASE_URL}/assets/{asset_id}", HEADERS, interval=5)

# Wait for knowledge store item (longer interval - indexing takes more time)
item = wait_for_ready(
    f"{BASE_URL}/knowledge-stores/{store_id}/items/{item_id}",
    HEADERS,
    interval=10,
    timeout=600
)
```

### Recommended Intervals

| Resource             | Poll Interval | Typical Wait | Timeout |
| -------------------- | ------------- | ------------ | ------- |
| Asset (direct)       | 5s            | 10-60s       | 120s    |
| Asset (URL)          | 5s            | 10-120s      | 300s    |
| Knowledge store item | 10s           | 1-10 min     | 600s    |

### Batch Polling

Wait for multiple resources in parallel:

```python

def wait_for_items(store_id, item_ids):
    """Wait for multiple knowledge store items in parallel."""
    def wait_one(item_id):
        return wait_for_ready(
            f"{BASE_URL}/knowledge-stores/{store_id}/items/{item_id}",
            HEADERS,
            interval=10
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(wait_one, iid): iid for iid in item_ids}
        results = {}
        for future in concurrent.futures.as_completed(futures):
            item_id = futures[future]
            results[item_id] = future.result()

    return results
```

### Polling Pitfalls

- **Don't poll too aggressively**: 1-second intervals waste rate limit budget
- **Always handle `failed`**: failed resources don't recover
- **Set a timeout**: don't poll forever if something goes wrong
- **Webhooks not available yet**: polling is the only option in Private Beta

## Jupyter notebook

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/twelvelabs-io/twelvelabs-developer-experience/blob/main/quickstarts/jockey/guides/error_handling.ipynb)
