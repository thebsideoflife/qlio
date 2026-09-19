/**
 * SporeLabs reframe client: retry policy, error envelope, key loader.
 *
 * Run: npx tsx src/services/sporelabs-reframe.test.ts
 */
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  REFRAME_MAX_SEGMENTS,
  SporeLabsError,
  buildReframeAssetKey,
  getReframe,
  getSporeLabsReframeApiKey,
  submitReframe,
  type ReframeClientOptions,
  type ReframeRequest,
} from "./sporelabs-reframe";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

const PRESIGNED =
  "https://media.s3.amazonaws.com/proxy/a.mp4?X-Amz-Signature=deadbeef";

const REQUEST: ReframeRequest = {
  video_url: PRESIGNED,
  asset_key: "zeevee/asset-1/abc123",
  fps: 24000 / 1001,
  source_aspect: 16 / 9,
  target_aspect: "9:16",
  segments: [{ id: "s1", start: 12.5, end: 98 }],
};

type Call = { url: string; init: RequestInit };

function mockFetch(
  responses: Array<(() => Response) | Error>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

function opts(fetchImpl: typeof fetch, sleeps: number[]): ReframeClientOptions {
  return {
    apiKey: "sk-test",
    baseUrl: "https://sporelabs.test/v1/",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

async function expectError(
  fn: () => Promise<unknown>,
): Promise<SporeLabsError | Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

async function main() {
  // Submit happy path: URL, auth, body shape, options defaults to {}.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([
      json(202, {
        id: "rf_1",
        object: "video.reframe",
        status: "queued",
        polling_url: "/v1/video/reframe/rf_1",
      }),
    ]);
    const res = await submitReframe(REQUEST, opts(fetchImpl, sleeps));
    assert(res.id === "rf_1", "submit returns job id");
    assert(calls.length === 1, "one call on success");
    assert(
      calls[0].url === "https://sporelabs.test/v1/video/reframe",
      "POST {base}/video/reframe, trailing slash trimmed",
    );
    assert(calls[0].init.method === "POST", "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert(headers.Authorization === "Bearer sk-test", "Bearer auth");
    const body = JSON.parse(String(calls[0].init.body));
    assert(
      body.options && Object.keys(body.options).length === 0,
      "options defaults to {}",
    );
    assert(body.fps === 24000 / 1001, "fps passes through at full precision");
    assert(body.segments[0].start === 12.5, "segment start in seconds");
    assert(sleeps.length === 0, "no backoff on success");
  }

  // 503, 503, then 202 → retried with backoff.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([
      json(503, { error: { message: "upstream", type: "server_error" } }),
      json(503, { error: { message: "upstream", type: "server_error" } }),
      json(202, { id: "rf_2", object: "video.reframe", status: "queued" }),
    ]);
    const res = await submitReframe(REQUEST, opts(fetchImpl, sleeps));
    assert(res.id === "rf_2", "succeeds after two 503s");
    assert(calls.length === 3, "three attempts");
    assert(sleeps.length === 2, "two backoffs");
    assert(sleeps[1] > sleeps[0], "backoff grows");
  }

  // 429 rate limit honours Retry-After, then succeeds.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([
      json(429, { error: { message: "slow down", type: "rate_limit" } }, { "Retry-After": "2" }),
      json(200, { id: "rf_3", object: "video.reframe", status: "in_progress" }),
    ]);
    const res = await getReframe("rf_3", opts(fetchImpl, sleeps));
    assert(res.status === "in_progress", "GET succeeds after 429");
    assert(calls.length === 2, "429 retried");
    assert(sleeps[0] === 2000, "Retry-After seconds respected");
    assert(
      calls[0].url === "https://sporelabs.test/v1/video/reframe/rf_3",
      "GET {base}/video/reframe/{id}",
    );
    assert(calls[0].init.body === undefined, "GET has no body");
  }

  // 408 is retried.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([
      json(408, { error: { message: "timeout" } }),
      json(200, { id: "rf_4", object: "video.reframe", status: "queued" }),
    ]);
    await getReframe("rf_4", opts(fetchImpl, sleeps));
    assert(calls.length === 2, "408 retried");
  }

  // 429 insufficient_quota: empty wallet, no retry.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([
      json(429, {
        error: {
          message: "Wallet balance too low",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    ]);
    const err = (await expectError(() =>
      submitReframe(REQUEST, opts(fetchImpl, sleeps)),
    )) as SporeLabsError;
    assert(err instanceof SporeLabsError, "insufficient_quota throws SporeLabsError");
    assert(calls.length === 1, "insufficient_quota not retried");
    assert(err?.status === 429 && err?.code === "insufficient_quota", "status + code kept");
    assert(err?.message.includes("Wallet balance too low"), "envelope message surfaced");
  }

  // 400 / 401 are not retried.
  for (const status of [400, 401]) {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([
      json(status, { error: { message: `bad ${status}`, type: "invalid_request_error" } }),
    ]);
    const err = (await expectError(() =>
      submitReframe(REQUEST, opts(fetchImpl, sleeps)),
    )) as SporeLabsError;
    assert(calls.length === 1, `${status} not retried`);
    assert(err?.status === status, `${status} status kept`);
    assert(err?.message.includes(`bad ${status}`), `${status} message surfaced`);
  }

  // Persistent 5xx gives up after maxAttempts.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([json(502, { error: { message: "bad gateway" } })]);
    const err = (await expectError(() =>
      getReframe("rf_5", { ...opts(fetchImpl, sleeps), maxAttempts: 3 }),
    )) as SporeLabsError;
    assert(calls.length === 3, "5xx gives up after maxAttempts");
    assert(err?.status === 502 && err.retryable, "last 5xx surfaced as retryable");
  }

  // Network errors retry, and the error never echoes the presigned URL.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([new TypeError("fetch failed")]);
    const err = await expectError(() =>
      submitReframe(REQUEST, { ...opts(fetchImpl, sleeps), maxAttempts: 2 }),
    );
    assert(calls.length === 2, "network error retried");
    assert(err instanceof SporeLabsError && err.status === 0, "network error → status 0");
    assert(!err?.message.includes("X-Amz-Signature"), "no presigned URL in error");
    assert(!err?.message.includes("sk-test"), "no key in error");
  }

  // Non-JSON 200 is an error, not a crash.
  {
    const sleeps: number[] = [];
    const { fetchImpl } = mockFetch([() => new Response("<html>", { status: 200 })]);
    const err = await expectError(() => getReframe("rf_6", opts(fetchImpl, sleeps)));
    assert(err instanceof SporeLabsError, "non-JSON body throws SporeLabsError");
  }

  // Input guards run before any HTTP.
  {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch([json(202, { id: "x" })]);
    const tooMany = {
      ...REQUEST,
      segments: Array.from({ length: REFRAME_MAX_SEGMENTS + 1 }, (_, i) => ({
        id: `s${i}`,
        start: i,
        end: i + 1,
      })),
    };
    const err = await expectError(() => submitReframe(tooMany, opts(fetchImpl, sleeps)));
    assert(err instanceof SporeLabsError, ">500 segments rejected");
    const bad = await expectError(() => getReframe("../etc", opts(fetchImpl, sleeps)));
    assert(bad instanceof SporeLabsError, "path-unsafe job id rejected");
    assert(calls.length === 0, "guards make no HTTP call");
  }

  // Asset key: opaque, quotes stripped, charset + length bounded.
  {
    assert(
      buildReframeAssetKey("a-1", '"9b2cf535f27731c974343645a3985328"') ===
        "zeevee/a-1/9b2cf535f27731c974343645a3985328",
      "ETag quotes stripped",
    );
    assert(
      buildReframeAssetKey("a-1", '"abc-3"') === "zeevee/a-1/abc-3",
      "multipart ETag kept",
    );
    assert(
      /^[A-Za-z0-9/_.:-]+$/.test(buildReframeAssetKey("a b", "x+y")),
      "charset enforced",
    );
    assert(buildReframeAssetKey("a".repeat(300), "e").length <= 200, "≤200 chars");
  }

  // Key loader: rejects placeholder/empty, caches a good key.
  {
    const original = SecretsManagerClient.prototype.send;
    const values = ["REPLACE_ME_PASTE_SPORELABS_KEY", "  ", "sk-live-123"];
    let sends = 0;
    (SecretsManagerClient.prototype as any).send = async () => ({
      SecretString: values[Math.min(sends++, values.length - 1)],
    });
    const prevArn = process.env.SPORELABS_SECRET_ARN;
    try {
      delete process.env.SPORELABS_SECRET_ARN;
      const noArn = await expectError(() => getSporeLabsReframeApiKey());
      assert(!!noArn?.message.includes("SPORELABS_SECRET_ARN"), "missing ARN is explicit");

      process.env.SPORELABS_SECRET_ARN = "arn:aws:secretsmanager:test";
      const placeholder = await expectError(() => getSporeLabsReframeApiKey());
      assert(!!placeholder?.message.includes("REPLACE_ME"), "placeholder rejected clearly");
      const empty = await expectError(() => getSporeLabsReframeApiKey());
      assert(!!empty, "empty secret rejected");
      const key = await getSporeLabsReframeApiKey();
      assert(key === "sk-live-123", "real key returned");
      await getSporeLabsReframeApiKey();
      assert(sends === 3, "good key cached in module scope");
    } finally {
      (SecretsManagerClient.prototype as any).send = original;
      if (prevArn === undefined) delete process.env.SPORELABS_SECRET_ARN;
      else process.env.SPORELABS_SECRET_ARN = prevArn;
    }
  }

  if (failures > 0) {
    console.error(`sporelabs-reframe: ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`sporelabs-reframe: ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
