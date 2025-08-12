import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers, getUrlInfo, prepareWAMessageMedia } = baileys;
import { useMongoDBAuthState } from 'bailey-mongodb';
import axios from 'axios';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';

const logger = pino({ level: 'silent' });
// --- SETUP ---
const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = "mongodb+srv://Xibs:%40%23%24123@cluster0.48u5qh4.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// --- DATABASE & MODELS ---
mongoose.connect(MONGO_URI).then(() => {
    console.log("MongoDB connected successfully.");
    initializeAllClientsOnStartup();
}).catch(err => console.error("MongoDB connection error:", err));

const ClientSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    avatarUrl: { type: String },
    phone: { type: String },
    connectedAt: { type: String },
    status: { type: String, required: true },
});
const ClientModel = mongoose.model('Client', ClientSchema);


const MessageSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    remoteJid: { type: String, required: true, index: true },
    fromMe: { type: Boolean, required: true },
    id: { type: String, required: true },
    // We store the entire message proto. This is crucial for the getMessage function.
    message: { type: Object },
    messageText: { type: String },
    timestamp: { type: Date, required: true },
});
// A compound index ensures each message is unique per session and speeds up lookups
MessageSchema.index({ sessionId: 1, id: 1 }, { unique: true });
const MessageModel = mongoose.model('Message', MessageSchema);

const ChatSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    id: { type: String, required: true },
    name: { type: String },
    unreadCount: { type: Number, default: 0 },
}, { strict: false }); // Allow other fields from Baileys
ChatSchema.index({ sessionId: 1, id: 1 }, { unique: true });
const ChatModel = mongoose.model('Chat', ChatSchema);

const ContactSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    id: { type: String, required: true },
    name: { type: String },
    notify: { type: String },
}, { strict: false }); // Allow other fields
ContactSchema.index({ sessionId: 1, id: 1 }, { unique: true });
const ContactModel = mongoose.model('Contact', ContactSchema);








const sessionsCollection = mongoose.connection.collection('sessions');


const activeSessions = new Map();

app.use(cors());
app.use(express.json());


import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

async function getPreviewBuffer(url) {
  const html = await fetch(url).then(res => res.text());
  const $ = cheerio.load(html);
  const imgUrl = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
  return imgUrl ? fetch(imgUrl).then(res => res.buffer()) : null;
}









// // The corrected, robust destroy function
// async function destroyClient(clientId, andDeleteFromDB = false) {
    // console.log(`Attempting to destroy client: ${clientId}`);

    // // --- Part 1: In-Memory Cleanup (Only if session is active) ---
    // const session = activeSessions.get(clientId);
    // if (session) {
        // console.log(`Session ${clientId} is active. Shutting down socket.`);
        // try {
			// session.sessionStop = true;
            // session.sock?.end(new Error('Client destroyed by request.'));
        // } catch (error) {
            // console.error(`Error while ending socket for ${clientId}:`, error.message);
        // }
        // activeSessions.delete(clientId);
    // } else {
        // console.log(`Session ${clientId} is not active in memory. Proceeding with storage cleanup.`);
    // }

    // // --- Part 2: Persistent Storage Cleanup (Always runs if requested) ---
    // if (andDeleteFromDB) {
        // console.log(`Permanently deleting data for ${clientId}.`);
        // try {
            // // Delete the client record from MongoDB
            // await ClientModel.deleteOne({ id: clientId });
            // console.log(`Deleted client record from MongoDB for ${clientId}.`);
        // } catch (error) {
            // console.error(`An error occurred during permanent deletion for ${clientId}:`, error);
        // }
    // }
// }








async function destroyClient(clientId, andDeleteFromDB = false) {
    console.log(`Attempting to destroy client: ${clientId}`);

    // --- Part 1: In-Memory Cleanup (Only if session is active) ---
    const session = activeSessions.get(clientId);
    if (session) {
        console.log(`Session ${clientId} is active. Shutting down socket.`);
        try {
			session.sessionStop = true;
            // End the connection gracefully
            session.sock?.end(new Error('Client destroyed by request.'));
            // Logout forces the phone to clear the session, a good practice for full cleanup
            // Use a try-catch in case the socket is already dead
            try { await session.sock?.logout(); } catch {}
        } catch (error) {
            console.error(`Error while ending socket for ${clientId}:`, error.message);
        }
        activeSessions.delete(clientId);
    } else {
        console.log(`Session ${clientId} is not active in memory. Proceeding with storage cleanup.`);
    }

    // --- Part 2: Persistent Storage Cleanup (Always runs if requested) ---
    if (andDeleteFromDB) {
        console.log(`Permanently deleting ALL data for client: ${clientId}.`);
        try {
            // We use Promise.all to run all deletion queries concurrently for speed.
            const [
                clientResult,
                messagesResult,
                chatsResult,
                contactsResult,
                authSessionResult
            ] = await Promise.all([
                // 1. Delete the main client record
                ClientModel.deleteOne({ id: clientId }),
				
                // 2. Delete all associated messages
                MessageModel.deleteMany({ sessionId: clientId }),
                // 3. Delete all associated chats
                ChatModel.deleteMany({ sessionId: clientId }),
                // 4. Delete all associated contacts
                ContactModel.deleteMany({ sessionId: clientId }),
                // 5. Delete the authentication credentials from the 'sessions' collection.
                // bailey-mongodb stores creds with keys like 'client-id:creds', 'client-id:app-state-sync-key-...'
                // A regex match on the _id is the correct way to clear them all.
                sessionsCollection.deleteMany({ _id: { $regex: `^${clientId}:` } })
            ]);

            console.log(`[Cleanup] Deleted for ${clientId}:`);
            console.log(`  - Client record: ${clientResult.deletedCount}`);
            console.log(`  - Messages: ${messagesResult.deletedCount}`);
            console.log(`  - Chats: ${chatsResult.deletedCount}`);
            console.log(`  - Contacts: ${contactsResult.deletedCount}`);
            console.log(`  - Auth Sessions: ${authSessionResult.deletedCount}`);

        } catch (error) {
            console.error(`An error occurred during permanent data deletion for ${clientId}:`, error);
        }
    }
}






// --- CORE WHATSAPP BOT FUNCTION ---
async function initializeClient(clientId, authDetails = { method: 'qr' }) {
    console.log(`Initializing client: ${clientId}`);

    if (activeSessions.has(clientId)) {
        await destroyClient(clientId);
    }
    
    await ClientModel.updateOne({ id: clientId }, { $set: { status: 'STARTING' } });
    
    // const { state, saveCreds } = await useMultiFileAuthState(clientId);
	const { state, saveCreds } = await useMongoDBAuthState(sessionsCollection, clientId);
	
    const session = {
        sock: null,
        isDestroying: false,  
        qrResolver: null,
        phoneCodeResolver: null,
		sessionStop: false,
    };
    session.qrPromise = new Promise((resolve) => { session.qrResolver = resolve; });
    session.phoneCodePromise = new Promise((resolve) => { session.phoneCodeResolver = resolve; });
    
    activeSessions.set(clientId, session);
    const recentMessageIds = new Map();


	const sock = makeWASocket({
		logger: logger,
		printQRInTerminal: false,
		browser: Browsers.macOS("Chrome"), // A desktop browser is recommended for full sync
		markOnlineOnConnect: false,
		// --- Add these two options ---
		syncFullHistory: true, // Asks for the full history
		
		// This allows Baileys to look up messages from our new database
		getMessage: async (key) => {
			const data = await MessageModel.findOne({ sessionId: clientId, id: key.id }).lean();
			return data?.message || undefined;
		},
		// ----------------------------
		
		auth: state,
		shouldIgnoreJid: jid => jid?.includes('@broadcast'),
	});



    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const currentSession = activeSessions.get(clientId);
        
        if (qr) {
            if (authDetails.method === 'qr') {
                await ClientModel.updateOne({ id: clientId }, { $set: { status: 'QR_NEEDED' } });
                currentSession?.qrResolver?.(qr);
            }
            else if (authDetails.method === 'phone' && authDetails.phoneNumber && !currentSession?.phoneCodePromise.isResolved) {
                try {
                    console.log(`Socket is ready, requesting pairing code for ${clientId}`);
                    const phoneNumber = authDetails.phoneNumber.replace(/[^0-9]/g, '');
                    const code = await sock.requestPairingCode(phoneNumber);
                    if(currentSession) currentSession.phoneCodePromise.isResolved = true;
                    currentSession?.phoneCodeResolver?.(code.replace(/[-\s]/g, ''));
                } catch (error) {
                    console.error('Failed to request pairing code:', error);
                    await ClientModel.updateOne({ id: clientId }, { $set: { status: 'FAILED' } });
                    currentSession?.phoneCodeResolver?.(null);
                    await destroyClient(clientId);
                }
            }
        }

        if (connection === 'open') {
            console.log(`Client ${clientId} is ready!`);
			sock.sendPresenceUpdate('unavailable')
            const userInfo = await sock.user;
            const phone = userInfo.id.split(':')[0];
            const name = userInfo.name || `Client ${phone}`;
            let avatarUrl = '';
            try { avatarUrl = await sock.profilePictureUrl(userInfo.id, 'image'); } catch { console.log('Could not fetch profile picture.'); }
            
            await ClientModel.updateOne({ id: clientId }, { $set: { name, phone, avatarUrl, status: 'RUNNING', connectedAt: new Date().toISOString() } });
            if(currentSession) { currentSession.qrResolver = null; currentSession.phoneCodeResolver = null; }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed for ${clientId}, reason: ${DisconnectReason[statusCode] || 'unknown'}`);
            
            if (statusCode === DisconnectReason.restartRequired) {
                console.log('Restart required, re-initializing client...');
                initializeClient(clientId, authDetails);
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log(`Client ${clientId} was logged out permanently. Deleting data.`);
                await destroyClient(clientId, true);
			} else if (statusCode === DisconnectReason.connectionReplaced) {
				await destroyClient(clientId);
				
			} else if (session.sessionStop != true) {
				console.log(`Client ${clientId} disconnected because of unknown problem. re-initializing client...`)
				initializeClient(clientId, authDetails);
			}
        }
    });



    // --- HANDLER 1: THE BULK HISTORY SYNC ---
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
        console.log(`[History Sync] Received initial sync data. Progress: ${progress}%. isLatest: ${isLatest}`);
        
        try {
            // Use bulkWrite for maximum efficiency
            if (chats.length > 0) {
                const chatOps = chats.map(chat => ({
                    updateOne: {
                        filter: { sessionId: clientId, id: chat.id },
                        update: { $set: { ...chat, sessionId: clientId } },
                        upsert: true,
                    }
                }));
                await ChatModel.bulkWrite(chatOps);
            }
            if (contacts.length > 0) {
                const contactOps = contacts.map(contact => ({
                    updateOne: {
                        filter: { sessionId: clientId, id: contact.id },
                        update: { $set: { ...contact, sessionId: clientId } },
                        upsert: true,
                    }
                }));
                await ContactModel.bulkWrite(contactOps);
            }
            if (messages.length > 0) {
                const messageOps = messages.map(msg => ({
                    updateOne: {
                        filter: { sessionId: clientId, id: msg.key.id },
                        update: { $set: {
                            sessionId: clientId,
                            id: msg.key.id,
                            remoteJid: msg.key.remoteJid,
                            fromMe: msg.key.fromMe,
                            message: msg.message,
                            messageText: msg.message?.conversation || msg.message?.extendedTextMessage?.text,
                            timestamp: new Date(msg.messageTimestamp * 1000)
                        }},
                        upsert: true,
                    }
                }));
                await MessageModel.bulkWrite(messageOps);
            }
            console.log(`[History Sync] Successfully saved ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages.`);
        } catch (error) {
            console.error('[History Sync] Error during bulk save:', error);
        }
    });



	const isDuplicate = (msgId) => {
		if (recentMessageIds.has(msgId)) return true;
		recentMessageIds.set(msgId, Date.now());

		// Optional: Limit memory by keeping only last 1000 messages
		if (recentMessageIds.size > 1000) {
			const keys = Array.from(recentMessageIds.keys()).slice(0, 500);
			for (const key of keys) recentMessageIds.delete(key);
		}

		return false;
	};


// --- REPLACE YOUR EXISTING 'messages.upsert' HANDLER WITH THIS ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // We only care about new, real-time messages. 'notify' is the key type for this.
		// if (type !== "notify") { 
			// return;
		// }

        // --- (MODIFICATION 1) HELPER FUNCTION TO SAVE OUTGOING MESSAGES ---
        // This wrapper function ensures that every message we send is also saved to our database.
        const sendMessageAndSave = async (jid, content, options = {}) => {
            const sentMsg = await sock.sendMessage(jid, content, options);
			sock.sendPresenceUpdate('unavailable')
            if (sentMsg) {

                await MessageModel.updateOne(
                    { sessionId: clientId, id: sentMsg.key.id }, // Filter by unique key
                    {
                        $set: { // The data to set on insert or update
                            sessionId: clientId,
                            id: sentMsg.key.id,
                            remoteJid: jid,
                            fromMe: true,
                            message: sentMsg.message,
                            messageText: content.text || content.caption || '',
                            timestamp: new Date()
                        }
                    },
                    { upsert: true } // The magic option: update if exists, insert if not
                );
				
            }
            return sentMsg;
        };


        for (const msg of messages) {
            // --- (MODIFICATION 2) SAVE EVERY INCOMING MESSAGE ---
            // We save the message to the database as soon as we receive it.
            // We do this before any filtering to ensure nothing is missed.
			if (isDuplicate(msg.key.id)) {
				return;
			}
            if (msg.message && msg.key.remoteJid) {
                try {
                    await MessageModel.updateOne(
                        { sessionId: clientId, id: msg.key.id },
                        {
                            $set: {
                                sessionId: clientId,
                                id: msg.key.id,
                                remoteJid: msg.key.remoteJid,
                                fromMe: msg.key.fromMe,
                                message: msg.message,
                                messageText: msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption,
                                timestamp: new Date(msg.messageTimestamp * 1000)
                            }
                        },
                        { upsert: true }
                    );
                } catch (err) {
                     // Ignore duplicate key errors which can happen in rare race conditions
                    if (err.code !== 11000) {
                        console.error('Error saving incoming message to DB:', err);
                    }
                }
            }


            // --- BOT LOGIC SECTION (Now starts after saving) ---
            
            // Filter out our own messages, status updates, and messages without content
            if (!msg.message || !msg.key.remoteJid) {
                return;
            }

            const sender = msg.key.remoteJid;
            const messageText =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                '';

            if (!messageText) return; // Still ignore messages with no text for the bot logic
            console.log(`Processing from ${sender}: "${messageText}"`);
            
			
            if (msg.key.fromMe) {
                return;
            }
			
			
			if (msg.key.remoteJid.includes('@broadcast') || msg.key.remoteJid.includes('@g.us')) {
				return;
			}
 			
			
			
            try {
                // Check if we have EVER replied to this person before.
                // const hasRepliedBefore = await MessageModel.findOne({
                    // sessionId: clientId,
                    // remoteJid: sender,
                    // fromMe: true // Look for a message sent *by us*
                // });

                // --- SCENARIO 1: First-time interaction ---
                if (true || messageText.toLowerCase().trim() === "!test") {


					const normalizeText = (str) => {
					  return str
						.replaceAll('ı', 'i')		
						.replaceAll('İ', 'i')
						.toLowerCase()
						.replaceAll('ş', 's')
						.replaceAll('ç', 'c')
						.replaceAll('ü', 'u')
						.replaceAll('ğ', 'g')
						.replaceAll('ı', 'i')		
						.replaceAll('ö', 'o');
					};

					const checkKeyword = (list, text) => {
					  const normalizedText = normalizeText(text);
					  return list.some(k => normalizedText.includes(normalizeText(k)));
					};


					const kelimelistesi = ["yo my boy"];


                    if (checkKeyword(kelimelistesi, messageText) || messageText.toLowerCase().trim() === "!test") {
                        console.log(`Keyword match from NEW contact ${sender}. Sending invitation message...`);

                        const replyText = "hi my nig";

                        // --- (MODIFICATION 3) USE THE WRAPPER FUNCTION ---
                        // Now we use our new function to send the message. It will be saved automatically.
                        await sendMessageAndSave(sender, {
                          text: replyText,
                          linkPreview: linkPreview
                        });
                        console.log(`Saved invitation reply to ${sender} via wrapper.`);
                    }
                }
                // --- SCENARIO 2: We have already replied before. Listen for commands. ---
                else {
                    const command = messageText.toLowerCase().trim();

                    switch (command) {
                        case '!info':
                            console.log(`Executing !info command for ${sender}`);
                            // --- USE THE WRAPPER FUNCTION ---
                            await sendMessageAndSave(sender, { text: `Oturum ID: ${clientId}` });
                            break;

                        case '!history':
                            console.log(`Executing !history command for ${sender}`);
                            const userMessageCount = await MessageModel.countDocuments({ sessionId: clientId, remoteJid: sender, fromMe: false });
                            const botMessageCount = await MessageModel.countDocuments({ sessionId: clientId, remoteJid: sender, fromMe: true });
                            const historyReply = `Konuşma Geçmişi:\n- Siz: ${userMessageCount} mesaj\n- Bot: ${botMessageCount} mesaj`;
                            // --- USE THE WRAPPER FUNCTION ---
                            await sendMessageAndSave(sender, { text: historyReply });
                            break;

                        case '!help':
                            console.log(`Executing !help command for ${sender}`);
                            const helpMessage = `Yardım Menüsü:\n- !info: Bu oturumun ID'sini gösterir.\n- !history: Bu sohbetteki mesaj sayılarını gösterir.\n- !help: Bu yardım menüsünü gösterir.`;
                            // --- USE THE WRAPPER FUNCTION ---
                            await sendMessageAndSave(sender, { text: helpMessage });
                            break;
                    }
                }
            } catch (error) {
                console.error(`Error processing message from ${sender}:`, error);
            }
        }
    });


    return session;
}


// --- API ROUTES ---
const apiRouter = express.Router();
apiRouter.get('/clients', async (req, res) => {
    try {
        const clients = await ClientModel.find();
        res.json(clients);
    } catch (error) { res.status(500).json({ message: "Failed to fetch clients", error }); }
});
apiRouter.post('/clients', async (req, res) => {
    try {
        const newClientDoc = new ClientModel({
            id: `client-${Date.now()}`, name: 'Yeni Kurulum Bekleniyor', status: 'PENDING_SETUP',
        });
        await newClientDoc.save();
        res.status(201).json(newClientDoc);
    } catch (error) { res.status(500).json({ message: "Failed to create client", error }); }
});
apiRouter.post('/clients/:id/generate-qr', async (req, res) => {
    const { id } = req.params;
    try {
        const session = await initializeClient(id, { method: 'qr' });
        const qr = await session.qrPromise;
        if (!qr) return res.status(500).json({ message: "QR code not generated, client might be connected." });
        const qrCodeUrl = await QRCode.toDataURL(qr, { margin: 1 });
        res.json({ qrCodeUrl, sessionId: id });
    } catch (error) { res.status(500).json({ message: 'Failed to generate QR code', error: error.message }); }
});
apiRouter.post('/clients/:id/generate-phone-code', async (req, res) => {
    const { id } = req.params;
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ message: 'Phone number is required.' });
    try {
        const session = await initializeClient(id, { method: 'phone', phoneNumber });
        const code = await session.phoneCodePromise;
        if (!code) return res.status(500).json({ message: "Code not generated, client might already be paired or an error occurred." });
        res.json({ code, sessionId: id });
    } catch (error) { res.status(500).json({ message: 'Failed to generate phone code', error: error.message }); }
});
apiRouter.get('/auth/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        const client = await ClientModel.findOne({ id: sessionId });
        if (!client) return res.status(404).json({ message: "Client session not found." });
        if (client.status === 'RUNNING') return res.json({ status: 'paired', client: client });
        if (client.status === 'FAILED') return res.status(410).json({ status: 'error', message: "EXPIRED" });
        res.json({ status: 'pending' });
    } catch (error) { res.status(500).json({ message: "Error checking status", error }); }
});
apiRouter.post('/auth/cancel/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    await destroyClient(sessionId, false);
    await ClientModel.updateOne({ id: sessionId, status: { $in: ['STARTING', 'QR_NEEDED'] } }, { $set: { status: 'STOPPED' } });
    res.json({ success: true });
});

// *** ADDED: The missing START and STOP routes ***
apiRouter.post('/clients/:id/start', async (req, res) => {
    const { id } = req.params;
    console.log(`API: Received request to start client ${id}`);
    initializeClient(id, { method: 'qr' }).catch(err => {
        console.error(`Failed to start client ${id} via API:`, err);
    });
    res.json({ success: true, message: 'Client initialization started.' });
});

apiRouter.post('/clients/:id/stop', async (req, res) => {
    const { id } = req.params;
    console.log(`API: Received request to stop client ${id}`);
    await destroyClient(id, false); // false = just stop, don't delete session files
    await ClientModel.updateOne({ id: id }, { $set: { status: 'STOPPED' } });
    res.json({ success: true, message: 'Client stopped.' });
});
// *** END of added routes ***

apiRouter.delete('/clients/:id', async (req, res) => {
    const { id } = req.params;
    await destroyClient(id, true);
    res.json({ success: true, message: 'Client disconnected and data deleted.' });
});
app.use('/api', apiRouter);

// --- STATIC FILE SERVING & STARTUP ---
const clientBuildPath = path.join(__dirname, '../dist');
app.use(express.static(clientBuildPath));
app.get('/', (req, res) => { res.sendFile(path.join(clientBuildPath, 'index.html')); });

// *** This function now correctly initializes running clients on startup ***
const initializeAllClientsOnStartup = async () => {
    try {
		const clientsToRestart = await ClientModel.find({ 
		  status: { $in: ['RUNNING', 'STARTING'] } 
		});
        if (clientsToRestart.length > 0) {
            for (const client of clientsToRestart) {
                console.log(`Auto-starting client: ${client.name} (${client.id})`);
                // Use .catch() to prevent one failed client from crashing the entire server
                initializeClient(client.id, { method: 'qr' }).catch(err => {
                    console.error(`Failed to auto-initialize client ${client.id}:`, err);
                });
            }
        } else {
            console.log('No running clients to initialize on startup.');
        }
    } catch (error) { 
        console.error("Error re-initializing clients on startup:", error); 
    }
};

app.listen(PORT, () => { console.log(`Server running at http://localhost:${PORT}`); });