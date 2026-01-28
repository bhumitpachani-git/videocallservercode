const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const fs = require('fs');
const config = require('../config');

const ddbClient = new DynamoDBClient(config.AWS);
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client(config.AWS);

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const DYNAMO_TABLE = process.env.DYNAMO_TABLE_NAME || 'MeetingRooms';

async function saveRoomDetails(roomData) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                roomId: roomData.roomId,
                ...roomData,
                updatedAt: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Room details saved: ${roomData.roomId}`);
    } catch (error) {
        console.error('[AWS] Error saving room details:', error);
    }
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
            },
        });

        await upload.done();
        console.log(`[AWS] File uploaded to S3: ${s3Key}`);
        return `s3://${S3_BUCKET}/${s3Key}`;
    } catch (error) {
        console.error('[AWS] Error uploading to S3:', error);
        throw error;
    }
}

module.exports = {
    saveRoomDetails,
    uploadFileToS3
};
