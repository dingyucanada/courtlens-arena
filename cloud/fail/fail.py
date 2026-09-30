"""Record orchestration failure when the Fargate task never gets to run."""
import os
import boto3


def handler(event, context):
    job_id = event.get("jobId")
    owner = event.get("ownerId")
    if not isinstance(job_id, str) or not isinstance(owner, str):
        raise ValueError("Missing job identity")
    table = os.environ["TABLE_NAME"]
    db = boto3.client("dynamodb")
    key = {"pk": {"S": "OWNER#" + owner}, "sk": {"S": "JOB#" + job_id}}
    row = db.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item")
    if not row:
        raise ValueError("Job missing")
    kind = row["jobType"]["S"]
    lock = "render" if kind == "render" else "analyze" if kind in ("analyze", "probe-provider", "cv") else "ingest"
    try:
        db.update_item(TableName=table, Key=key, UpdateExpression="SET #status=:failed, errorMessage=:reason",
                       ConditionExpression="#status IN (:queued,:running,:committing,:publishing)",
                       ExpressionAttributeNames={"#status": "status"}, ExpressionAttributeValues={":failed": {"S": "failed"}, ":reason": {"S": "Orchestration task failed; inspect Step Functions execution"},
                       ":queued": {"S": "queued"}, ":running": {"S": "running"}, ":committing": {"S": "committing"}, ":publishing": {"S": "publishing"}})
    except db.exceptions.ConditionalCheckFailedException:
        return {"recorded": False}
    try:
        db.delete_item(TableName=table, Key={"pk": {"S": "SYSTEM"}, "sk": {"S": "LOCK#" + lock}},
                       ConditionExpression="jobId=:job", ExpressionAttributeValues={":job": {"S": job_id}})
    except db.exceptions.ConditionalCheckFailedException:
        pass
    return {"recorded": True}
