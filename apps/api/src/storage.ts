import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { demand, hash } from "./config.js";
import type { Row } from "./db.js";
export async function archiveArtifact(a: Row) {
  const bucket = process.env.ARTIFACT_S3_BUCKET;
  if (!bucket) return null;
  const endpoint = process.env.ARTIFACT_S3_ENDPOINT;
  if (endpoint) {
    const u = new URL(endpoint);
    demand(
      u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)),
      422,
      "S3 endpoint requires HTTPS outside loopback",
    );
  }
  demand(hash(a.content) === a.sha256, 409, "Artifact checksum mismatch");
  const client = new S3Client({
    endpoint,
    region: process.env.ARTIFACT_S3_REGION || "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: process.env.ARTIFACT_S3_ACCESS_KEY
      ? {
          accessKeyId: process.env.ARTIFACT_S3_ACCESS_KEY,
          secretAccessKey: process.env.ARTIFACT_S3_SECRET_KEY || "",
        }
      : undefined,
  });
  const key = `runs/${a.run_id}/${a.id}.json`;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(a.content),
        ContentType: "application/json",
        Metadata: { sha256: a.sha256 },
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  } finally {
    client.destroy();
  }
  return { bucket, key, sha256: a.sha256, artifact_id: a.id };
}
