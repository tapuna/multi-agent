"""Optional S3-compatible replication; Firebird artifacts remain authoritative."""

import base64
import hashlib
import os
from urllib.parse import urlparse


def archive_artifact(artifact):
    bucket = os.getenv("ARTIFACT_S3_BUCKET")
    if not bucket:
        return None
    endpoint = os.getenv("ARTIFACT_S3_ENDPOINT") or None
    if endpoint:
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" and not (
            parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("S3 endpoint requires HTTPS outside loopback")
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.getenv("ARTIFACT_S3_ACCESS_KEY"),
        aws_secret_access_key=os.getenv("ARTIFACT_S3_SECRET_KEY"),
        region_name=os.getenv("ARTIFACT_S3_REGION", "us-east-1"),
        config=Config(
            connect_timeout=5,
            read_timeout=10,
            retries={"max_attempts": 1},
            s3={"addressing_style": "path"},
        ),
    )
    content = artifact.content.encode()
    sha = hashlib.sha256(content).hexdigest()
    if sha != artifact.sha256:
        raise ValueError("Artifact checksum mismatch")
    key = f"runs/{artifact.run_id}/{artifact.id}.json"
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=content,
        ContentType="application/json",
        ContentMD5=base64.b64encode(hashlib.md5(content).digest()).decode(),
        Metadata={"sha256": sha},
    )
    return {"bucket": bucket, "key": key, "sha256": sha, "artifact_id": artifact.id}
