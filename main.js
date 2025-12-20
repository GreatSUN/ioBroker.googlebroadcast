'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const path = require('path');
const fs = require('fs');

class GoogleBroadcast extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'googlebroadcast',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.assistant = null;
        this.mdns = null;
        this.scanInterval = null;
        this.deviceMap = new Map(); // IP -> { name, type }
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // 1. Initialize Google Assistant Connection
        await this.initGoogleAssistant();

        // 2. Initialize mDNS Scanner
        this.initMdns();

        // 3. Set up periodic scan if configured
        const intervalMinutes = this.config.scanInterval || 30;
        if (intervalMinutes > 0) {
            this.log.info(`Scheduling device scan every ${intervalMinutes} minutes.`);
            this.scanInterval = setInterval(() => {
                this.scanNetwork();
            }, intervalMinutes * 60 * 1000);
        }

        // 4. Initial Scan
        this.scanNetwork();

        // 5. Subscribe to states
        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('groups.*.broadcast');
    }

    /**
     * Initialize the Google Assistant SDK
     */
    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        const savedTokensJson = this.config.savedTokens;

        if (!credentialsJson || !savedTokensJson) {
            this.log.warn('Missing Google Credentials or Tokens. Please configure them in Adapter Settings.');
            this.setState('info.connection', false, true);
            return;
        }

        try {
            const keys = JSON.parse(credentialsJson);
            const tokens = JSON.parse(savedTokensJson);

            const config = {
                auth: {
                    type: 'authorized_user',
                    client_id: keys.installed ? keys.installed.client_id : keys.web.client_id,
                    client_secret: keys.installed ? keys.installed.client_secret : keys.web.client_secret,
                    refresh_token: tokens.refresh_token,
                },
                conversation: {
                    isNew: true,
                    lang: 'en-US', // Default, will detect language from text usually or device settings
                    deviceModelId: this.config.deviceModelId || 'iobroker-broadcast-v1',
                    deviceLocation: {
                        coordinates: {
                            latitude: 0,
                            longitude: 0
                        }
                    }
                }
            };

            this.assistant = new GoogleAssistant(config.auth);
            
            // Basic check if auth works by hook or just assuming ready
            this.assistant.on('ready', () => {
                this.log.info('Google Assistant SDK ready.');
                this.setState('info.connection', true, true);
            });
            
            this.assistant.on('error', (err) => {
                this.log.error('Google Assistant Error: ' + err);
                this.setState('info.connection', false, true);
            });

        } catch (e) {
            this.log.error('Failed to initialize Google Assistant: ' + e.message);
            this.setState('info.connection', false, true);
        }
    }

    /**
     * Send text command to Assistant
     */
    sendBroadcast(textCommand) {
        if (!this.assistant) {
            this.log.error('Assistant not initialized. Cannot broadcast.');
            return;
        }

        const config = {
            conversation: {
                textQuery: textCommand,
                isNew: true,
                deviceModelId: this.config.deviceModelId,
            }
        };

        this.log.debug(`Sending command to Google: "${textCommand}"`);

        this.assistant.start(config.conversation, (conversation) => {
            conversation
                .on('audio-data', (data) => {
                    // We don't really care about the audio response
                })
                .on('end-of-utterance', () => {
                    // Utterance done
                })
                .on('transcription', (data) => {
                    this.log.debug('Google Response Transcription: ' + data.transcription);
                })
                .on('response', (text) => {
                    if (text) this.log.debug('Google Text Response: ' + text);
                })
                .on('ended', (error, continueConversation) => {
                    if (error) this.log.error('Conversation Error: ' + error);
                    else this.log.debug('Broadcast conversation ended.');
                })
                .on('error', (error) => {
                    this.log.error('Conversation Error: ' + error);
                });
        });
    }

    /**
     * Initialize mDNS listener
     */
    initMdns() {
        this.mdns = mDNS();
        
        this.mdns.on('response', (response) => {
            this.processMdnsResponse(response);
        });
    }

    /**
     * Trigger a network scan
     */
    scanNetwork() {
        this.log.info('Scanning for Google Cast devices...');
        if (this.mdns) {
            this.mdns.query({
                questions: [{
                    name: '_googlecast._tcp.local',
                    type: 'PTR'
                }]
            });
        }
    }

    /**
     * Process mDNS packets to find devices/groups
     */
    async processMdnsResponse(response) {
        // Loop through answers/additionals to find the data we need
        const records = [...response.answers, ...response.additionals];
        
        // Use an IP to identify unique devices for the session map
        // but we mainly care about the TXT record for the name
        
        let friendlyName = null;
        let modelDescription = null;
        let port = 8009;
        let host = null;

        // Extract TXT fields
        const txtRecord = records.find(r => r.type === 'TXT' && r.name.includes('_googlecast'));
        if (txtRecord && txtRecord.data) {
            // Buffer to array of strings
            const dataParts = [];
            let buf = txtRecord.data;
            if (Array.isArray(buf)) {
                 // multicast-dns returns array of Buffers
                 buf.forEach(b => {
                     // Parse key=value
                     const str = b.toString();
                     dataParts.push(str);
                 });
            }

            dataParts.forEach(part => {
                if (part.startsWith('fn=')) friendlyName = part.substring(3);
                if (part.startsWith('md=')) modelDescription = part.substring(3);
            });
        }

        if (!friendlyName) return;

        // Normalize ID
        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // Determine if Group or Device
        const isGroup = (modelDescription === 'Google Cast Group');
        const folder = isGroup ? 'groups' : 'devices';
        
        // Create Objects
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, {
            type: 'device',
            common: {
                name: friendlyName
            },
            native: {
                model: modelDescription
            }
        });

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, {
            type: 'state',
            common: {
                name: `Broadcast to ${friendlyName}`,
                type: 'string',
                role: 'text',
                read: true,
                write: true
            },
            native: {
                friendlyName: friendlyName // Important: Store the real name for the query
            }
        });
        
        // Subscribe to the new state
        this.subscribeStates(`${folder}.${cleanId}.broadcast`);
    }

    /**
     * Is called when state changes
     */
    async onStateChange(id, state) {
        if (state && !state.ack) {
            // ACK=false means command from user
            
            // 1. Broadcast All
            if (id.endsWith('broadcast_all')) {
                const cmd = `Broadcast ${state.val}`;
                this.sendBroadcast(cmd);
                this.setState(id, state.val, true); // Ack
            }
            
            // 2. Specific Device/Group
            else if (id.includes('.devices.') || id.includes('.groups.')) {
                // Retrieve the object to get the real Friendly Name
                const obj = await this.getObjectAsync(id);
                if (obj && obj.native && obj.native.friendlyName) {
                    const target = obj.native.friendlyName;
                    const cmd = `Broadcast to ${target} ${state.val}`;
                    this.sendBroadcast(cmd);
                    this.setState(id, state.val, true); // Ack
                }
            }
        }
    }

    /**
     * Admin UI Messages
     */
    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'scan') {
                this.scanNetwork();
                if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'Scan started' }, obj.callback);
            }
            
            // OAUTH FLOW HELPER
            if (obj.command === 'getAuthUrl') {
                // User provided credentials in msg
                const creds = obj.message; // { client_id, client_secret, ... }
                try {
                     const OAuth2 = GoogleAssistant.OAuth2;
                     // We manually construct Client because the lib doesn't expose the URL generator easily without a file
                     // Using a helper approach or manual URL construction
                     // Ideally, we use google-auth-library, but let's try to keep it simple.
                     
                     // Constructing URL manually for standard Google Auth
                     const url = `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fassistant-sdk-prototype&response_type=code&client_id=${creds.client_id}&redirect_uri=urn:ietf:wg:oauth:2.0:oob`;
                     
                     this.sendTo(obj.from, obj.command, { url: url }, obj.callback);
                } catch (e) {
                    this.log.error(e);
                }
            }

            if (obj.command === 'exchangeCode') {
                const { code, clientId, clientSecret } = obj.message;
                const { google } = require('googleapis');
                const oauth2Client = new google.auth.OAuth2(
                    clientId,
                    clientSecret,
                    'urn:ietf:wg:oauth:2.0:oob'
                );

                try {
                    const { tokens } = await oauth2Client.getToken(code);
                    this.sendTo(obj.from, obj.command, { tokens: tokens }, obj.callback);
                } catch (e) {
                     this.log.error("Error exchanging code: " + e);
                     this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
                }
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.scanInterval) clearInterval(this.scanInterval);
            if (this.mdns) this.mdns.destroy();
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main === module) {
    new GoogleBroadcast();
} else {
    module.exports = (options) => new GoogleBroadcast(options);
}