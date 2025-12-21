'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const google = require('googleapis').google; 

class GoogleBroadcast extends utils.Adapter {

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
    }

    async onReady() {
        // 1. Initialize Google Assistant Connection
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

        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('groups.*.broadcast');
    }

    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        let savedTokensJson = this.config.savedTokens;
        const authCode = this.config.authCode;

        // --- NEW: AUTO-EXCHANGE LOGIC ---
        // If we have credentials and a code, but no tokens (or user pasted a new code), try to exchange it.
        if (credentialsJson && authCode) {
            this.log.info('Auth Code detected in configuration. Attempting to generate tokens...');
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
                    this.log.info('Tokens generated successfully! Saving to configuration...');

                    // Save new tokens and clear the code so we don't try again
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: {
                            savedTokens: JSON.stringify(tokens),
                            authCode: "" 
                        }
                    });
                    
                    // The adapter will usually restart automatically after config change.
                    // If not, we can proceed using the new tokens in memory.
                    savedTokensJson = JSON.stringify(tokens);
                }
            } catch (e) {
                this.log.error('Failed to exchange Auth Code for Tokens: ' + e.message);
                // We do NOT return here, we fall through to try initialization 
                // in case the old tokens were still valid.
            }
        }
        // --------------------------------

        if (!credentialsJson || !savedTokensJson) {
            this.log.warn('Missing Credentials or Tokens. Please configure via Admin Settings.');
            return;
        }

        try {
            const keys = JSON.parse(credentialsJson);
            const tokens = JSON.parse(savedTokensJson);
            const clientConfig = keys.installed || keys.web;

            const config = {
                auth: {
                    type: 'authorized_user',
                    client_id: clientConfig.client_id,
                    client_secret: clientConfig.client_secret,
                    refresh_token: tokens.refresh_token,
                },
                conversation: {
                    isNew: true,
                    lang: 'en-US',
                    deviceModelId: this.config.deviceModelId || 'iobroker-model',
                    deviceLocation: { coordinates: { latitude: 0, longitude: 0 } }
                }
            };

            this.assistant = new GoogleAssistant(config.auth);
            
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
        }
    }

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

    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'scan') {
                this.scanNetwork();
                if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'Scan started' }, obj.callback);
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