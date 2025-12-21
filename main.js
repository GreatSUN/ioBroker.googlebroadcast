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
        this.mdns = null;
        this.scanInterval = null;
        
        // Define paths for temporary files
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.instance}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.instance}_tokens.json`);
    }

    async onReady() {
        // 1. Try Initialize (Will wait if no tokens in state)
        await this.initGoogleAssistant();

        // 2. Initialize mDNS
        this.initMdns();

        // 3. Periodic Scan
        const intervalMinutes = this.config.scanInterval || 30;
        if (intervalMinutes > 0) {
            this.scanInterval = setInterval(() => this.scanNetwork(), intervalMinutes * 60 * 1000);
        }
        this.scanNetwork();

        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('groups.*.broadcast');
    }

    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        
        // Get tokens from STATE, not config
        const tokenState = await this.getStateAsync('tokens');
        let tokensJson = tokenState && tokenState.val ? tokenState.val : null;

        // If tokens are object, stringify
        if (typeof tokensJson === 'object') tokensJson = JSON.stringify(tokensJson);

        if (!credentialsJson || !tokensJson || tokensJson === '{}') {
            this.log.warn('Adapter waiting for authentication. Please use the "Generate Tokens" button in Admin.');
            this.setState('info.connection', false, true);
            return;
        }

        try {
            // Write files to temp dir
            fs.writeFileSync(this.credsPath, credentialsJson);
            fs.writeFileSync(this.tokensPath, tokensJson);
            
            const config = {
                auth: {
                    keyFilePath: this.credsPath,
                    savedTokensPath: this.tokensPath,
                },
                conversation: {
                    isNew: true,
                    lang: 'en-US',
                    deviceModelId: this.config.deviceModelId || 'iobroker-model',
                    deviceLocation: { coordinates: { latitude: 0, longitude: 0 } }
                }
            };

            // If we are re-initializing, clean up old instance
            if (this.assistant) {
                this.assistant.removeAllListeners();
                this.assistant = null;
            }

            this.assistant = new GoogleAssistant(config.auth);
            
            this.assistant.on('ready', () => {
                this.log.info('Google Assistant SDK connected!');
                this.setState('info.connection', true, true);
            });
            
            this.assistant.on('error', (err) => {
                this.log.error('Google Assistant Error: ' + err);
                this.setState('info.connection', false, true);
            });

            this.assistant.start();

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
            
            // --- NEW AUTH FLOW ---
            if (obj.command === 'exchangeCode') {
                const { code, clientId, clientSecret } = obj.message;
                const oauth2Client = new google.auth.OAuth2(
                    clientId,
                    clientSecret,
                    'urn:ietf:wg:oauth:2.0:oob'
                );

                try {
                    const { tokens } = await oauth2Client.getToken(code);
                    this.log.info('Tokens generated successfully via Admin!');
                    
                    // 1. Save tokens to STATE (No restart triggered)
                    await this.setStateAsync('tokens', JSON.stringify(tokens), true);
                    
                    // 2. Initialize immediately
                    await this.initGoogleAssistant();

                    // 3. Tell Admin it worked
                    this.sendTo(obj.from, obj.command, { tokens: tokens }, obj.callback);
                } catch (e) {
                     this.log.error("Auth Exchange Error: " + e);
                     this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
                }
            }
        }
    }

    sendBroadcast(textCommand) {
        if (!this.assistant) {
            this.log.warn('Cannot broadcast: Assistant not ready.');
            return;
        }
        // ... (Existing broadcast logic remains same) ...
        const config = {
            conversation: {
                textQuery: textCommand,
                isNew: true,
                deviceModelId: this.config.deviceModelId,
                deviceLocation: { coordinates: { latitude: 0, longitude: 0 } }
            }
        };
        this.assistant.start(config.conversation, (conversation) => {
            conversation
                .on('response', (text) => text && this.log.debug('Google: ' + text))
                .on('ended', (err) => err ? this.log.error('Error: ' + err) : this.log.debug('Broadcast sent.'))
                .on('error', (err) => this.log.error('Conversation Error: ' + err));
        });
    }

    // ... (mDNS logic remains same) ...
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
        // ... (Keep existing parsing logic) ...
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
            common: { name: `Broadcast to ${friendlyName}`, type: 'string', role: 'text', read: true, write: true },
            native: { friendlyName: friendlyName }
        });
        this.subscribeStates(`${folder}.${cleanId}.broadcast`);
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            if (id.endsWith('broadcast_all')) {
                this.sendBroadcast(`Broadcast ${state.val}`);
                this.setState(id, state.val, true);
            } else if (id.includes('.broadcast')) {
                const obj = await this.getObjectAsync(id);
                if (obj && obj.native && obj.native.friendlyName) {
                    this.sendBroadcast(`Broadcast to ${obj.native.friendlyName} ${state.val}`);
                    this.setState(id, state.val, true);
                }
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.scanInterval) clearInterval(this.scanInterval);
            if (this.mdns) this.mdns.destroy();
            // Cleanup temp files
            if (fs.existsSync(this.credsPath)) fs.unlinkSync(this.credsPath);
            if (fs.existsSync(this.tokensPath)) fs.unlinkSync(this.tokensPath);
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