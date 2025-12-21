'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

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
        
        // Define paths for the temporary files the library needs
        this.credsPath = path.join(__dirname, 'credentials.json');
        this.tokensPath = path.join(__dirname, 'tokens.json');
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // 1. Initialize Google Assistant
        await this.initGoogleAssistant();

        // 2. Initialize mDNS Scanner
        this.initMdns();

        // 3. Periodic Scan
        const intervalMinutes = this.config.scanInterval || 30;
        if (intervalMinutes > 0) {
            this.log.info(`Scheduling device scan every ${intervalMinutes} minutes.`);
            this.scanInterval = setInterval(() => {
                this.scanNetwork();
            }, intervalMinutes * 60 * 1000);
        }

        // 4. Initial Scan
        this.scanNetwork();

        // 5. Subscribe
        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('groups.*.broadcast');
    }

    /**
     * Initialize the Google Assistant SDK
     */
    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        let savedTokensJson = this.config.savedTokens;
        const authCode = this.config.authCode;

        // --- AUTO-EXCHANGE LOGIC ---
        if (credentialsJson && authCode) {
            this.log.info('Auth Code detected. Attempting to generate tokens...');
            try {
                const keys = JSON.parse(credentialsJson);
                const clientConfig = keys.installed || keys.web;
                
                if (clientConfig) {
                    const oauth2Client = new google.auth.OAuth2(
                        clientConfig.client_id,
                        clientConfig.client_secret,
                        'urn:ietf:wg:oauth:2.0:oob'
                    );

                    const { tokens } = await oauth2Client.getToken(authCode);
                    this.log.info('Tokens generated successfully! Saving configuration...');

                    // Save new tokens and clear code
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: {
                            savedTokens: JSON.stringify(tokens),
                            authCode: "" 
                        }
                    });
                    
                    // Stop here. The adapter will restart automatically due to config change.
                    // This prevents race conditions.
                    return; 
                }
            } catch (e) {
                this.log.error('Failed to exchange Auth Code: ' + e.message);
            }
        }

        if (!credentialsJson || !savedTokensJson) {
            this.log.warn('Missing Credentials or Tokens. Waiting for Admin configuration...');
            return;
        }

        try {
            // --- WRITE FILES TO DISK ---
            // The library REQUIRES files, so we create them from our DB config
            fs.writeFileSync(this.credsPath, credentialsJson);
            fs.writeFileSync(this.tokensPath, savedTokensJson);
            
            const config = {
                auth: {
                    // Point the library to the files we just wrote
                    keyFilePath: this.credsPath,
                    savedTokensPath: this.tokensPath,
                },
                conversation: {
                    isNew: true,
                    lang: 'en-US',
                    deviceModelId: this.config.deviceModelId || 'iobroker-model',
                    deviceLocation: {
                        coordinates: {
                            latitude: 0,
                            longitude: 0
                        }
                    }
                }
            };

            this.assistant = new GoogleAssistant(config.auth);
            
            this.assistant.on('ready', () => {
                this.log.info('Google Assistant SDK ready.');
                this.setState('info.connection', true, true);
            });
            
            // v0.7.0 error handling
            this.assistant.on('error', (err) => {
                this.log.error('Google Assistant Connection Error: ' + err);
                this.setState('info.connection', false, true);
            });
            
            // Start the library (it triggers the 'ready' event)
            this.assistant.start();

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
                deviceLocation: { coordinates: { latitude: 0, longitude: 0 } }
            }
        };

        this.log.debug(`Sending command to Google: "${textCommand}"`);

        try {
            this.assistant.start(config.conversation, (conversation) => {
                conversation
                    .on('audio-data', (data) => {})
                    .on('end-of-utterance', () => {})
                    .on('transcription', (data) => {
                        this.log.debug('Google Transcription: ' + (data.transcription || data));
                    })
                    .on('response', (text) => {
                        if (text) this.log.debug('Google Text Response: ' + text);
                    })
                    .on('ended', (error, continueConversation) => {
                        if (error) {
                            this.log.error('Broadcast Conversation Ended with Error: ' + error);
                        } else {
                            this.log.debug('Broadcast conversation finished successfully.');
                        }
                    })
                    .on('error', (error) => {
                        this.log.error('Broadcast Conversation Error: ' + error);
                    });
            });
        } catch (error) {
            this.log.error(`Failed to start conversation: ${error}`);
        }
    }

    /**
     * Initialize mDNS listener
     */
    initMdns() {
        try {
            this.mdns = mDNS();
            this.mdns.on('response', (response) => {
                this.processMdnsResponse(response);
            });
        } catch (e) {
            this.log.error('Failed to initialize mDNS: ' + e.message);
        }
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
        const records = [...response.answers, ...response.additionals];
        let friendlyName = null;
        let modelDescription = null;

        const txtRecord = records.find(r => r.type === 'TXT' && r.name.includes('_googlecast'));
        if (txtRecord && txtRecord.data) {
            const dataParts = [];
            let buf = txtRecord.data;
            if (Array.isArray(buf)) {
                 buf.forEach(b => {
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

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isGroup = (modelDescription === 'Google Cast Group');
        const folder = isGroup ? 'groups' : 'devices';
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, {
            type: 'device',
            common: { name: friendlyName },
            native: { model: modelDescription }
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
            native: { friendlyName: friendlyName }
        });
        
        this.subscribeStates(`${folder}.${cleanId}.broadcast`);
    }

    /**
     * Is called when state changes
     */
    async onStateChange(id, state) {
        if (state && !state.ack) {
            if (id.endsWith('broadcast_all')) {
                const cmd = `Broadcast ${state.val}`;
                this.sendBroadcast(cmd);
                this.setState(id, state.val, true); 
            }
            else if (id.includes('.devices.') || id.includes('.groups.')) {
                const obj = await this.getObjectAsync(id);
                if (obj && obj.native && obj.native.friendlyName) {
                    const target = obj.native.friendlyName;
                    const cmd = `Broadcast to ${target} ${state.val}`;
                    this.sendBroadcast(cmd);
                    this.setState(id, state.val, true);
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
            // 'exchangeCode' is now handled via auto-detect on startup, 
            // but we keep this listener if you ever want to revert to button-based logic.
            if (obj.command === 'exchangeCode') {
                const { code, clientId, clientSecret } = obj.message;
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

    /**
     * Cleanup files on unload
     */
    onUnload(callback) {
        try {
            if (this.scanInterval) clearInterval(this.scanInterval);
            if (this.mdns) this.mdns.destroy();
            
            // Optional: Clean up temp files
            // if (fs.existsSync(this.credsPath)) fs.unlinkSync(this.credsPath);
            // if (fs.existsSync(this.tokensPath)) fs.unlinkSync(this.tokensPath);
            
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