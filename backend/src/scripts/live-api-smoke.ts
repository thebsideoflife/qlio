/**
 * Live API smoke tests for export metadata + thumbnails.
 * Run: API_PASSWORD='...' npx tsx src/scripts/live-api-smoke.ts
 */

const API_URL =
  process.env.API_URL ||
  "https://4bvanrvph5.execute-api.us-west-2.amazonaws.com";
const API_PASSWORD = process.env.API_PASSWORD;

if (!API_PASSWORD) {
  console.error("Set API_PASSWORD env var");
  process.exit(1);
}

const headers = {
  "x-api-password": API_PASSWORD,
  "Content-Type": "application/json",
};

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, data };
}

async function main() {
  console.log("\n=== Live API smoke (test-account) ===\n");

  const assetsRes = await req("GET", "/assets/status");
  ok(assetsRes.status === 200, `GET /assets/status → ${assetsRes.status}`);
  const assets = assetsRes.data as Array<{
    id: string;
    status: string;
    title: string;
  }>;
  ok(Array.isArray(assets) && assets.length > 0, "has assets");

  const assetId =
    assets.find((a) => a.status === "completed" || a.status === "READY")?.id ||
    assets[0]?.id;
  ok(!!assetId, `asset selected: ${assetId}`);

  const projectsRes = await req("GET", `/projects?assetId=${assetId}`);
  ok(projectsRes.status === 200, `GET /projects?assetId → ${projectsRes.status}`);
  const projects = projectsRes.data as Array<{
    projectId: string;
    segmentCount: number;
    thumbnailUrl: string | null;
    thumbnailStale: boolean;
  }>;
  ok(Array.isArray(projects), "projects is array");
  console.log(
    `    ${projects.length} projects, stale thumbs: ${projects.filter((p) => p.thumbnailStale).length}`,
  );

  const projectWithSegments = projects.find((p) => p.segmentCount > 0);
  if (!projectWithSegments) {
    console.log("\n  ⚠ No projects with segments — skipping metadata tests\n");
    console.log(`=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  const projectId = projectWithSegments.projectId;
  console.log(`    using project ${projectId}`);

  const ensureRes = await req(
    "POST",
    `/assets/${assetId}/ensure-project-thumbnails`,
    {},
  );
  ok(
    ensureRes.status === 200 || ensureRes.status === 202,
    `POST ensure-project-thumbnails → ${ensureRes.status}`,
  );
  if (ensureRes.status === 202) {
    const data = ensureRes.data as { status?: string; pendingCount?: number };
    ok(data.status === "generating", "ensure returned async generating");
    console.log(`    pendingCount: ${data.pendingCount ?? "?"}`);
  }

  const projectRes = await req("GET", `/projects/${projectId}`);
  ok(projectRes.status === 200, `GET /projects/:id → ${projectRes.status}`);
  const project = projectRes.data as {
    segments?: Array<{ id: string; startTime: number; endTime: number }>;
    segmentMetadata?: unknown[];
    thumbnailUrl?: string | null;
    thumbnailKey?: string;
  };
  ok(!!project.segments?.length, "project has segments");
  ok(
    project.thumbnailKey === undefined,
    "GET project omits internal thumbnailKey",
  );

  const segmentIds = project.segments!.map((s) => s.id);

  const metaRes = await req("POST", `/projects/${projectId}/export-metadata`, {
    segmentIds: [segmentIds[0]],
    options: {
      includeTitles: true,
      includeDescriptions: true,
      descriptionLengths: ["short"],
      includeThumbnails: true,
    },
  });
  ok(
    metaRes.status === 200 || metaRes.status === 202,
    `POST export-metadata → ${metaRes.status}`,
  );

  if (metaRes.status === 202) {
    const start = metaRes.data as { jobId: string; status: string };
    ok(!!start.jobId, "async metadata job started");

    const deadline = Date.now() + 600_000;
    let completed = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const jobRes = await req("GET", `/projects/${projectId}/job`);
      const jobData = jobRes.data as {
        exportMetadataJob?: { status: string; segmentErrors?: unknown[] };
      };
      const job = jobData.exportMetadataJob;
      console.log(`    poll: ${job?.status ?? "none"}`);
      if (job?.status === "completed") {
        completed = true;
        ok(true, "export metadata job completed");
        break;
      }
      if (job?.status === "failed") {
        ok(false, `export metadata job failed: ${JSON.stringify(job)}`);
        break;
      }
    }
    ok(completed, "metadata job finished within timeout");
  } else if (metaRes.status === 200) {
    const data = metaRes.data as {
      segments?: Array<{ segmentId: string; thumbnailUrl?: string; thumbnailKey?: string }>;
      thumbnailKey?: string;
    };
    ok(Array.isArray(data.segments), "fast-path returns segments");
    ok(
      data.segments?.[0]?.thumbnailKey === undefined,
      "response omits internal thumbnailKey",
    );
  }

  const jobRes = await req("GET", `/projects/${projectId}/job`);
  ok(jobRes.status === 200, `GET /projects/:id/job → ${jobRes.status}`);
  const jobData = jobRes.data as { exportMetadataJob?: { status: string } };
  ok(!!jobData.exportMetadataJob, "exportMetadataJob present in job status");

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
