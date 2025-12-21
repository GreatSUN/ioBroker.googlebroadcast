'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
        this.assistantReady = false;
        this.mdns = null;
        this.scanInterval = null;
        this.credsPath = null;
        this.tokensPath = null;
    }

    async onReady() {
        // Define paths safely
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_tokens.json`);

        // 1. Initialize Assistant
        await this.initGoogleAssistant();

        // 2. Initialize mDNS
        this.initMdns();

        // 3. Periodic Scan
        const intervalMinutes = this.config.scanInterval || 30;
        if (intervalMinutes > 0) {
            this.scanInterval = setInterval(() => this.scanNetwork(), intervalMinutes * 60 * 1000);
        }
        this.scanNetwork();

        // Subscribe to wildcards - THIS IS ENOUGH. 
        // We do NOT subscribe again in scan results to avoid double triggers.
        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('groups.*.broadcast');
    }

    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        
        // --- AUTH LOGIC START ---
        const tokenState = await this.getStateAsync('tokens');
        let tokensJson = tokenState && tokenState.val ? tokenState.val : null;
        let tokensObj = null;

        if (tokensJson && typeof tokensJson === 'string' && tokensJson !== '{}') {
            try {
                tokensObj = JSON.parse(tokensJson);
            } catch (e) {
                this.log.warn('Stored tokens were invalid JSON. Ignoring.');
            }
        }

        if (!tokensObj && this.config.authCode && credentialsJson) {
            this.log.info('No tokens found, but Auth Code detected. Attempting exchange...');
            try {
                const keys = JSON.parse(credentialsJson);
                const clientConfig = keys.installed || keys.web;
                
                const oauth2Client = new google.auth.OAuth2(
                    clientConfig.client_id,
                    clientConfig.client_secret,
                    'urn:ietf:wg:oauth:2.0:oob'
                );

                const { tokens } = await oauth2Client.getToken(this.config.authCode);
                if (tokens) {
                    this.log.info('Tokens generated successfully! Saving to State.');
                    tokensObj = tokens;
                    tokensJson = JSON.stringify(tokens);
                    await this.setStateAsync('tokens', tokensJson, true);
                }
            } catch (e) {
                this.log.error('Failed to exchange Auth Code: ' + e.message);
                this.log.info('Please generate a NEW code in Admin and Save again.');
            }
        }

        if (!credentialsJson || !tokensObj) {
            this.log.warn('Adapter is not authenticated. Please go to Instance Settings, paste Credentials & Auth Code, and Save.');
            this.setState('info.connection', false, true);
            return;
        }
        // --- AUTH LOGIC END ---

        try {
            fs.writeFileSync(this.credsPath, credentialsJson);
            fs.writeFileSync(this.tokensPath, tokensJson);
            
            const config = {
                auth: {
                    keyFilePath: this.credsPath,
                    savedTokensPath: this.tokensPath,
                },
                conversation: {
                    isNew: true,
                    // Use Default Language from Config
                    lang: this.config.language || 'en-US', 
                    deviceModelId: this.config.deviceModelId || 'iobroker-model',
                    deviceLocation: { coordinates: { latitude: 0, longitude: 0 } }
                }
            };

            if (this.assistant) {
                this.assistant.removeAllListeners();
                this.assistant = null;
            }
            this.assistantReady = false;

            this.assistant = new GoogleAssistant(config.auth);
            
            this.assistant.on('ready', () => {
                this.log.info('Google Assistant SDK connected!');
                this.assistantReady = true;
                this.setState('info.connection', true, true);
            });
            
            this.assistant.on('error', (err) => {
                this.log.error('Google Assistant Error: ' + err);
                this.assistantReady = false;
                this.setState('info.connection', false, true);
            });

        } catch (e) {
            this.log.error('Init failed: ' + e.message);
        }
    }

    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'scan') {
                this.scanNetwork();
                if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'OK' }, obj.callback);
            }
        }
    }

    sendBroadcast(textCommand, lang) {
        if (!this.assistant || !this.assistantReady) {
            this.log.warn('Cannot broadcast: Assistant not ready yet.');
            return;
        }

        // Use passed language, or config default, or fallback to en-US
        const finalLang = lang || this.config.language || 'en-US';

        const config = {
            conversation: {
                textQuery: textCommand,
                isNew: true,
                lang: finalLang,
                deviceModelId: this.config.deviceModelId,
                deviceLocation: { coordinates: { latitude: 0, longitude: 0 } }
            }
        };

        this.log.debug(`Sending broadcast (${finalLang}): "${textCommand}"`);

        this.assistant.start(config.conversation, (conversation) => {
            conversation
                .on('response', (text) => text && this.log.debug('Google Response: ' + text))
                .on('ended', (err) => err ? this.log.error('Error: ' + err) : this.log.debug('Broadcast sent.'))
                .on('error', (err) => this.log.error('Conversation Error: ' + err));
        });
    }

    initMdns() {
        try {
            this.mdns = mDNS();
            this.mdns.on('response', (res) => this.processMdnsResponse(res));
        } catch (e) { this.log.error('mDNS Error: ' + e.message); }
    }
    
    scanNetwork() {
        if (this.mdns) this.mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
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
        
        // 1. Create Device Folder/Object
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, {
            type: 'device',
            common: { name: friendlyName },
            native: { model: modelDescription }
        });

        // 2. Create Broadcast State
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, {
            type: 'state',
            common: { name: `Broadcast to ${friendlyName}`, type: 'string', role: 'text', read: true, write: true },
            native: { friendlyName: friendlyName }
        });

        // 3. Create Language State (New!)
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.language`, {
            type: 'state',
            common: { 
                name: `Language for ${friendlyName}`, 
                type: 'string', 
                role: 'text', 
                read: true, 
                write: true, 
                def: this.config.language || 'en-US',
                desc: 'Two-letter code (en-US, de-DE)' 
            },
            native: {}
        });
        
        // Removed: this.subscribeStates(...) to prevent double broadcast
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val) { // Ensure value is not null/empty
            
            // 1. Broadcast All
            if (id.endsWith('broadcast_all')) {
                const cmd = `Broadcast ${state.val}`;
                // Use default global language
                this.sendBroadcast(cmd, this.config.language);
                // Clear state
                this.setState(id, null, true);
            } 
            
            // 2. Specific Device Broadcast
            else if (id.includes('.broadcast')) {
                const obj = await this.getObjectAsync(id);
                if (obj && obj.native && obj.native.friendlyName) {
                    
                    // Determine language for this specific device
                    const langId = id.replace('.broadcast', '.language');
                    const langState = await this.getStateAsync(langId);
                    const lang = (langState && langState.val) ? langState.val : this.config.language;

                    const target = obj.native.friendlyName;
                    const cmd = `Broadcast to ${target} ${state.val}`;
                    
                    this.sendBroadcast(cmd, lang);
                    
                    // Clear state
                    this.setState(id, null, true);
                }
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.scanInterval) clearInterval(this.scanInterval);
            if (this.mdns) this.mdns.destroy();
            if (this.credsPath && fs.existsSync(this.credsPath)) fs.unlinkSync(this.credsPath);
            if (this.tokensPath && fs.existsSync(this.tokensPath)) fs.unlinkSync(this.tokensPath);
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