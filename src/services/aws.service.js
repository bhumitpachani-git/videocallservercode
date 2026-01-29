const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const fs = require('fs');
const config = require('../config');

const ddbClient = new DynamoDBClient({
    region: config.AWS.region,
    credentials: config.AWS.credentials
});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({
    region: config.AWS.region,
    credentials: config.AWS.credentials
});

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const DYNAMO_TABLE = process.env.DYNAMO_TABLE_NAME || 'MeetingLogs';

async function logUserJoin(roomId, userDetails) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `JOIN#${userDetails.socketId}#${Date.now()}`,
                type: 'USER_JOIN',
                ...userDetails,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
    } catch (error) {
        console.error('[AWS] Error logging user join:', error);
    }
}

async function saveChatTranscript(roomId, transcript) {
    setImmediate(async () => {
        try {
            const command = new PutCommand({
                TableName: DYNAMO_TABLE,
                Item: {
                    aavrtiadmin: "aavrtiadmin",
                    pk: `ROOM#${roomId}`,
                    sk: `TRANSCRIPT#${Date.now()}`,
                    type: 'CHAT_TRANSCRIPT',
                    transcript,
                    timestamp: new Date().toISOString()
                }
            });
            await docClient.send(command);
        } catch (error) {
            console.error('[AWS] Error saving transcript:', error);
        }
    });
}

async function uploadFileToS3(filePath, s3Key) {
    try {
        const fileStream = fs.createReadStream(filePath);
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: S3_BUCKET,
                Key: s3Key,
                Body: fileStream,
                ContentType: 'video/mp4'
            },
            queueSize: 4,
            partSize: 1024 * 1024 * 5,
            leavePartsOnError: false,
        });

        await upload.done();
        console.log(`[AWS] Professional S3 upload complete: ${s3Key}`);

        return `https://${S3_BUCKET}.s3.${config.AWS.region}.amazonaws.com/${s3Key}`;
    } catch (error) {
        console.error('[AWS] Error during professional S3 upload:', error);
        throw error;
    }
}

async function saveRoomDetails(roomData) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomData.roomId}`,
                sk: 'METADATA',
                type: 'ROOM_METADATA',
                ...roomData,
                updatedAt: new Date().toISOString()
            }
        });
        await docClient.send(command);
    } catch (error) {
        console.error('[AWS] Error saving room details:', error);
    }
}

async function getRoomHistory(roomId) {
    try {
        const command = new QueryCommand({
            TableName: DYNAMO_TABLE,
            KeyConditionExpression: "aavrtiadmin = :admin AND pk = :pk",
            ExpressionAttributeValues: {
                ":admin": "aavrtiadmin",
                ":pk": `ROOM#${roomId}`
            },
            ScanIndexForward: false 
        });
        const response = await docClient.send(command);
        return response.Items || [];
    } catch (error) {
        console.error('[AWS] Error fetching room history:', error);
        return [];
    }
}

module.exports = {
    logUserJoin,
    saveChatTranscript,
    saveRoomDetails,
    uploadFileToS3,
    getRoomHistory
};
