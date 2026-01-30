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
const docClient = DynamoDBDocumentClient.from(ddbClient, {
    marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true
    }
});
const s3Client = new S3Client({
    region: config.AWS.region,
    credentials: config.AWS.credentials
});

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const DYNAMO_TABLE = process.env.DYNAMO_TABLE_NAME || 'MeetingLogs';

async function logUserJoin(roomId, sessionId, userDetails) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#JOIN#${userDetails.socketId}#${Date.now()}`,
                type: 'USER_JOIN',
                sessionId,
                ...userDetails,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] User join logged: ${userDetails.username} in room ${roomId}`);
    } catch (error) {
        console.error('[AWS] Error logging user join:', error);
    }
}

async function logUserLeave(roomId, sessionId, userDetails) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#LEAVE#${userDetails.socketId}#${Date.now()}`,
                type: 'USER_LEAVE',
                sessionId,
                ...userDetails,
                leftAt: new Date().toISOString(),
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] User leave logged: ${userDetails.username} from room ${roomId}`);
    } catch (error) {
        console.error('[AWS] Error logging user leave:', error);
    }
}

async function saveChatTranscript(roomId, sessionId, transcript) {
    if (!transcript || transcript.length === 0) {
        console.log(`[AWS] Skipping empty chat save for ${roomId}`);
        return;
    }
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#CHAT#${Date.now()}`,
                type: 'CHAT_TRANSCRIPT',
                sessionId,
                messageCount: transcript.length,
                messages: JSON.parse(JSON.stringify(transcript)), 
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Chat stored for ${roomId} session ${sessionId} (${transcript.length} messages)`);
    } catch (error) {
        console.error('[AWS] Error saving transcript:', error);
    }
}

async function savePollData(roomId, sessionId, pollData) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#POLL#${pollData.id}#${Date.now()}`,
                type: 'POLL_DATA',
                sessionId,
                pollId: pollData.id,
                question: pollData.question,
                options: pollData.options,
                results: pollData.results,
                totalVotes: pollData.totalVotes,
                creatorUsername: pollData.creatorUsername,
                isAnonymous: pollData.isAnonymous,
                allowMultiple: pollData.allowMultiple,
                active: pollData.active,
                action: pollData.action,
                createdAt: pollData.createdAt,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Poll ${pollData.action} saved: ${pollData.question} in room ${roomId}`);
    } catch (error) {
        console.error('[AWS] Error saving poll data:', error);
    }
}

async function saveNotesData(roomId, sessionId, notesContent) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#NOTES#${Date.now()}`,
                type: 'NOTES_DATA',
                sessionId,
                content: notesContent,
                contentLength: notesContent?.length || 0,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Notes saved for room ${roomId} (${notesContent?.length || 0} chars)`);
    } catch (error) {
        console.error('[AWS] Error saving notes:', error);
    }
}

async function saveSessionEvent(roomId, sessionId, eventData) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#EVENT#${eventData.eventType}#${Date.now()}`,
                type: 'SESSION_EVENT',
                sessionId,
                eventType: eventData.eventType,
                ...eventData,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Session event logged: ${eventData.eventType} for room ${roomId}`);
    } catch (error) {
        console.error('[AWS] Error saving session event:', error);
    }
}

async function closeSession(roomId, sessionId, sessionSummary) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#CLOSED`,
                type: 'SESSION_CLOSED',
                sessionId,
                startedAt: sessionSummary.startedAt,
                closedAt: new Date().toISOString(),
                duration: sessionSummary.duration,
                totalParticipants: sessionSummary.totalParticipants,
                totalMessages: sessionSummary.totalMessages,
                totalPolls: sessionSummary.totalPolls,
                hasNotes: sessionSummary.hasNotes,
                hasWhiteboard: sessionSummary.hasWhiteboard,
                hasTranscript: sessionSummary.hasTranscript,
                participants: sessionSummary.participants,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Session closed: ${sessionId} for room ${roomId}`);
    } catch (error) {
        console.error('[AWS] Error closing session:', error);
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

async function saveRoomDetails(roomId, sessionId, roomData) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#METADATA#${Date.now()}`,
                type: 'ROOM_METADATA',
                sessionId,
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
            KeyConditionExpression: "aavrtiadmin = :admin",
            FilterExpression: "pk = :pk",
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

async function getSessionHistory(roomId, sessionId) {
    try {
        const command = new QueryCommand({
            TableName: DYNAMO_TABLE,
            KeyConditionExpression: "aavrtiadmin = :admin AND begins_with(sk, :sessionPrefix)",
            FilterExpression: "pk = :pk",
            ExpressionAttributeValues: {
                ":admin": "aavrtiadmin",
                ":pk": `ROOM#${roomId}`,
                ":sessionPrefix": `SESSION#${sessionId}`
            },
            ScanIndexForward: true
        });
        const response = await docClient.send(command);
        return response.Items || [];
    } catch (error) {
        console.error('[AWS] Error fetching session history:', error);
        return [];
    }
}

async function saveTranscription(roomId, sessionId, transcriptData) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#TRANSCRIPTION#LIVE#${Date.now()}`,
                type: 'LIVE_TRANSCRIPTION',
                sessionId,
                ...transcriptData,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
    } catch (error) {
        console.error('[AWS] Error saving live transcription:', error);
    }
}

async function saveFullTranscription(roomId, sessionId, transcript) {
    try {
        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                aavrtiadmin: "aavrtiadmin",
                pk: `ROOM#${roomId}`,
                sk: `SESSION#${sessionId}#FULL_TRANSCRIPT`,
                type: 'FULL_TRANSCRIPT',
                sessionId,
                transcript,
                timestamp: new Date().toISOString()
            }
        });
        await docClient.send(command);
        console.log(`[AWS] Full transcript saved for room ${roomId} session ${sessionId}`);
    } catch (error) {
        console.error('[AWS] Error saving full transcription:', error);
    }
}

async function getOrganizedRoomHistory(roomId) {
    try {
        const allItems = await getRoomHistory(roomId);
        
        const sessions = {};
        const roomMetadata = [];
        
        allItems.forEach(item => {
            const sessionMatch = item.sk?.match(/SESSION#([^#]+)/);
            const sessionId = sessionMatch ? sessionMatch[1] : null;
            
            if (sessionId) {
                if (!sessions[sessionId]) {
                    sessions[sessionId] = {
                        sessionId,
                        userJoins: [],
                        userLeaves: [],
                        chatMessages: [],
                        polls: [],
                        notes: [],
                        transcripts: [],
                        whiteboardUpdates: [],
                        events: [],
                        metadata: null,
                        closedAt: null
                    };
                }
                
                switch (item.type) {
                    case 'USER_JOIN':
                        sessions[sessionId].userJoins.push({
                            username: item.username,
                            socketId: item.socketId,
                            joinedAt: item.timestamp
                        });
                        break;
                    case 'USER_LEAVE':
                        sessions[sessionId].userLeaves.push({
                            username: item.username,
                            socketId: item.socketId,
                            leftAt: item.leftAt || item.timestamp,
                            duration: item.duration
                        });
                        break;
                    case 'CHAT_TRANSCRIPT':
                        sessions[sessionId].chatMessages.push({
                            messages: item.messages || item.transcript,
                            messageCount: item.messageCount,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'POLL_DATA':
                        sessions[sessionId].polls.push({
                            pollId: item.pollId,
                            question: item.question,
                            options: item.options,
                            results: item.results,
                            totalVotes: item.totalVotes,
                            creatorUsername: item.creatorUsername,
                            action: item.action,
                            active: item.active,
                            createdAt: item.createdAt,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'NOTES_DATA':
                        sessions[sessionId].notes.push({
                            content: item.content,
                            contentLength: item.contentLength,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'LIVE_TRANSCRIPTION':
                    case 'FULL_TRANSCRIPT':
                        sessions[sessionId].transcripts.push({
                            type: item.type,
                            transcript: item.transcript || item.transcripts,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'ROOM_METADATA':
                        if (item.action === 'WHITEBOARD_UPDATE' || item.action === 'WHITEBOARD_UNDO') {
                            sessions[sessionId].whiteboardUpdates.push({
                                action: item.action,
                                savedAt: item.updatedAt
                            });
                        } else {
                            sessions[sessionId].metadata = item;
                        }
                        break;
                    case 'SESSION_EVENT':
                        sessions[sessionId].events.push({
                            eventType: item.eventType,
                            timestamp: item.timestamp,
                            details: item
                        });
                        break;
                    case 'SESSION_CLOSED':
                        sessions[sessionId].closedAt = item.closedAt;
                        sessions[sessionId].summary = {
                            startedAt: item.startedAt,
                            duration: item.duration,
                            totalParticipants: item.totalParticipants,
                            totalMessages: item.totalMessages,
                            totalPolls: item.totalPolls,
                            hasNotes: item.hasNotes,
                            hasWhiteboard: item.hasWhiteboard,
                            participants: item.participants
                        };
                        break;
                }
            }
        });
        
        const sessionsArray = Object.values(sessions).sort((a, b) => {
            const aTime = a.metadata?.updatedAt || a.userJoins[0]?.joinedAt || '';
            const bTime = b.metadata?.updatedAt || b.userJoins[0]?.joinedAt || '';
            return bTime.localeCompare(aTime);
        });
        
        return {
            roomId,
            totalSessions: sessionsArray.length,
            sessions: sessionsArray
        };
    } catch (error) {
        console.error('[AWS] Error organizing room history:', error);
        return { roomId, totalSessions: 0, sessions: [] };
    }
}

async function getRoomHistory(roomId) {
    try {
        const command = new QueryCommand({
            TableName: DYNAMO_TABLE,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: {
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

async function getSessionHistory(roomId, sessionId) {
    try {
        const command = new QueryCommand({
            TableName: DYNAMO_TABLE,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :sessionPrefix)",
            ExpressionAttributeValues: {
                ":pk": `ROOM#${roomId}`,
                ":sessionPrefix": `SESSION#${sessionId}`
            },
            ScanIndexForward: true
        });
        const response = await docClient.send(command);
        return response.Items || [];
    } catch (error) {
        console.error('[AWS] Error fetching session history:', error);
        return [];
    }
}

async function getOrganizedRoomHistory(roomId) {
    try {
        const allItems = await getRoomHistory(roomId);
        
        const sessions = {};
        
        allItems.forEach(item => {
            const sessionMatch = item.sk?.match(/SESSION#([^#]+)/);
            const sessionId = sessionMatch ? sessionMatch[1] : null;
            
            if (sessionId) {
                if (!sessions[sessionId]) {
                    sessions[sessionId] = {
                        sessionId,
                        userJoins: [],
                        userLeaves: [],
                        chatMessages: [],
                        polls: [],
                        notes: [],
                        transcripts: [],
                        whiteboardUpdates: [],
                        events: [],
                        metadata: null,
                        closedAt: null
                    };
                }
                
                switch (item.type) {
                    case 'USER_JOIN':
                        sessions[sessionId].userJoins.push({
                            username: item.username,
                            socketId: item.socketId,
                            joinedAt: item.timestamp
                        });
                        break;
                    case 'USER_LEAVE':
                        sessions[sessionId].userLeaves.push({
                            username: item.username,
                            socketId: item.socketId,
                            leftAt: item.leftAt || item.timestamp,
                            duration: item.duration
                        });
                        break;
                    case 'CHAT_TRANSCRIPT':
                        sessions[sessionId].chatMessages.push({
                            messages: item.messages || item.transcript,
                            messageCount: item.messageCount,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'POLL_DATA':
                        sessions[sessionId].polls.push({
                            pollId: item.pollId,
                            question: item.question,
                            options: item.options,
                            results: item.results,
                            totalVotes: item.totalVotes,
                            creatorUsername: item.creatorUsername,
                            action: item.action,
                            active: item.active,
                            createdAt: item.createdAt,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'NOTES_DATA':
                        sessions[sessionId].notes.push({
                            content: item.content,
                            contentLength: item.contentLength,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'LIVE_TRANSCRIPTION':
                    case 'FULL_TRANSCRIPT':
                        sessions[sessionId].transcripts.push({
                            type: item.type,
                            transcript: item.transcript || item.transcripts,
                            savedAt: item.timestamp
                        });
                        break;
                    case 'ROOM_METADATA':
                        if (item.action === 'WHITEBOARD_UPDATE' || item.action === 'WHITEBOARD_UNDO') {
                            sessions[sessionId].whiteboardUpdates.push({
                                action: item.action,
                                savedAt: item.updatedAt
                            });
                        } else {
                            sessions[sessionId].metadata = item;
                        }
                        break;
                    case 'SESSION_EVENT':
                        sessions[sessionId].events.push({
                            eventType: item.eventType,
                            timestamp: item.timestamp,
                            details: item
                        });
                        break;
                    case 'SESSION_CLOSED':
                        sessions[sessionId].closedAt = item.closedAt;
                        sessions[sessionId].summary = {
                            startedAt: item.startedAt,
                            duration: item.duration,
                            totalParticipants: item.totalParticipants,
                            totalMessages: item.totalMessages,
                            totalPolls: item.totalPolls,
                            hasNotes: item.hasNotes,
                            hasWhiteboard: item.hasWhiteboard,
                            participants: item.participants
                        };
                        break;
                }
            }
        });
        
        const sessionsArray = Object.values(sessions).sort((a, b) => {
            const aTime = a.metadata?.updatedAt || a.userJoins[0]?.joinedAt || '';
            const bTime = b.metadata?.updatedAt || b.userJoins[0]?.joinedAt || '';
            return bTime.localeCompare(aTime);
        });
        
        return {
            roomId,
            totalSessions: sessionsArray.length,
            sessions: sessionsArray
        };
    } catch (error) {
        console.error('[AWS] Error organizing room history:', error);
        return { roomId, totalSessions: 0, sessions: [] };
    }
}

module.exports = {
    logUserJoin,
    logUserLeave,
    saveChatTranscript,
    savePollData,
    saveNotesData,
    saveSessionEvent,
    closeSession,
    saveRoomDetails,
    saveTranscription,
    saveFullTranscription,
    uploadFileToS3,
    getRoomHistory,
    getSessionHistory,
    getOrganizedRoomHistory
};
