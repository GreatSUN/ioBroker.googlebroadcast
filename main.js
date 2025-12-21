'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const googleTTS = require('google-tts-api');

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
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_tokens.json`);

        if (this.config.broadcastMode === 'cast') {
            this.log.info('Starting in Chromecast TTS Mode');
            this.setState('info.connection', true, true);
        } else {
            await this.initGoogleAssistant();
        }

        this.initMdns();

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
        // ... (No changes to Assistant logic) ...
        const credentialsJson = this.config.jsonCredentials;
        const tokenState = await this.getStateAsync('tokens');
        let tokensJson = tokenState && tokenState.val ? tokenState.val : null;
        let tokensObj = null;

        if (tokensJson && typeof tokensJson === 'string' && tokensJson !== '{}') {
            try { tokensObj = JSON.parse(tokensJson); } catch (e) { }
        }

        if (!tokensObj && this.config.authCode && credentialsJson) {
            this.log.info('Auth Code detected. Attempting exchange...');
            try {
                const keys = JSON.parse(credentialsJson);
                const clientConfig = keys.installed || keys.web;
                const oauth2Client = new google.auth.OAuth2(
                    clientConfig.client_id, clientConfig.client_secret, 'urn:ietf:wg:oauth:2.0:oob'
                );
                const { tokens } = await oauth2Client.getToken(this.config.authCode);
                if (tokens) {
                    this.log.info('Tokens generated successfully!');
                    tokensObj = tokens;
                    tokensJson = JSON.stringify(tokens);
                    await this.setStateAsync('tokens', tokensJson, true);
                }
            } catch (e) {
                this.log.error('Failed to exchange Auth Code: ' + e.message);
            }
        }

        if (!credentialsJson || !tokensObj) {
            this.log.warn('Assistant not authenticated. Please configure in Admin or switch to "Chromecast TTS" mode.');
            this.setState('info.connection', false, true);
            return;
        }

        try {
            fs.writeFileSync(this.credsPath, credentialsJson);
            fs.writeFileSync(this.tokensPath, tokensJson);
            
            const config = {
                auth: { keyFilePath: this.credsPath, savedTokensPath: this.tokensPath },
                conversation: {
                    isNew: true,
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
            this.log.warn('Cannot broadcast: Assistant not ready.');
            return;
        }
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
        this.log.debug(`Assistant Broadcast (${finalLang}): "${textCommand}"`);
        this.assistant.start(config.conversation, (conversation) => {
            conversation.on('ended', (err) => err ? this.log.error('Error: ' + err) : this.log.debug('Sent.'))
                        .on('error', (err) => this.log.error('Conversation Error: ' + err));
        });
    }

    async castTTS(deviceIp, text, lang) {
        if (!deviceIp) {
            this.log.error('Cannot Cast: Device IP missing.');
            return;
        }
        const finalLang = lang || this.config.language || 'en-US';
        const speed = this.config.ttsSpeed || 1;
        
        try {
            const url = googleTTS.getAudioUrl(text, {
                lang: finalLang,
                slow: speed < 1,
                host: 'https://translate.google.com',
            });

            this.log.debug(`Casting TTS to ${deviceIp}: "${text}"`);
            const client = new Client();
            
            client.connect(deviceIp, () => {
                client.launch(DefaultMediaReceiver, (err, player) => {
                    if (err) {
                        this.log.error('Cast Launch Error: ' + err);
                        client.close();
                        return;
                    }
                    const media = {
                        contentId: url,
                        contentType: 'audio/mp3',
                        streamType: 'BUFFERED'
                    };
                    
                    player.load(media, { autoplay: true }, (err, status) => {
                        if (err) {
                            this.log.error('Cast Load Error: ' + err);
                            client.close();
                        } else {
                            this.log.debug('Playback started. Waiting for end...');
                        }
                    });

                    // Wait for playback to finish before closing connection
                    player.on('status', (status) => {
                        if (status && status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
                            this.log.debug('Playback finished. Closing connection.');
                            client.close();
                        }
                    });
                });
            });
            
            client.on('error', (err) => {
                // Ignore "closed" errors that happen on normal shutdown
                if (err.message && !err.message.includes('closed')) {
                    this.log.error('Cast Client Error: ' + err);
                }
                try { client.close(); } catch(e) {}
            });
            
        } catch (e) {
            this.log.error('TTS Generation Error: ' + e.message);
        }
    }

    initMdns() {
        try {
            this.mdns = mDNS();
            this.mdns.on('response', (res) => this.processMdnsResponse(res));
        } catch (e) { this.log.error('mDNS Error: ' + e.message); }
    }
    
    scanNetwork() {
        this.log.info('Scanning for Google Cast devices via mDNS...');
        if (this.mdns) this.mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
    }

    async processMdnsResponse(response) {
        const records = [...response.answers, ...response.additionals];
        
        const ptr = records.find(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');
        if (!ptr) return;
        const instanceName = ptr.data;

        let friendlyName = null;
        let model = null;
        const txt = records.find(r => r.type === 'TXT' && r.name === instanceName);
        if (txt && Array.isArray(txt.data)) {
            txt.data.forEach(buf => {
                const s = buf.toString();
                if (s.startsWith('fn=')) friendlyName = s.substring(3);
                if (s.startsWith('md=')) model = s.substring(3);
            });
        }

        const srv = records.find(r => r.type === 'SRV' && r.name === instanceName);
        if (!srv) return;
        
        const port = srv.data.port;
        const targetHost = srv.data.target;

        const normalize = (name) => name ? name.toLowerCase().replace(/\.$/, '') : '';
        const cleanTarget = normalize(targetHost);

        const aRecord = records.find(r => r.type === 'A' && normalize(r.name) === cleanTarget);
        const ip = aRecord ? aRecord.data : null;

        if (!friendlyName) return;

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isGroup = (model === 'Google Cast Group');
        const folder = isGroup ? 'groups' : 'devices';
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, {
            type: 'device',
            common: { name: friendlyName },
            native: { model: model, ip: ip, port: port }
        });
        
        if (ip) {
            await this.extendObjectAsync(`${folder}.${cleanId}`, {
                native: { ip: ip, port: port }
            });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.address`, {
            type: 'state',
            common: { name: 'IP Address', type: 'string', role: 'info.ip', read: true, write: false, def: '' },
            native: {}
        });
        if (ip) await this.setStateAsync(`${folder}.${cleanId}.address`, ip, true);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.port`, {
            type: 'state',
            common: { name: 'Port', type: 'number', role: 'info.port', read: true, write: false, def: 8009 },
            native: {}
        });
        if (port) await this.setStateAsync(`${folder}.${cleanId}.port`, port, true);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, {
            type: 'state',
            common: { name: `Broadcast to ${friendlyName}`, type: 'string', role: 'text', read: true, write: true },
            native: { friendlyName: friendlyName }
        });

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.language`, {
            type: 'state',
            common: { 
                name: `Language`, 
                type: 'string', role: 'text', read: true, write: true, 
                def: this.config.language || 'en-US' 
            },
            native: {}
        });
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val) {
            
            if (id.endsWith('broadcast_all')) {
                const lang = this.config.language || 'en-US';
                if (this.config.broadcastMode === 'cast') {
                    const devices = await this.getDevicesAsync();
                    for (const dev of devices) {
                        if (dev.native && dev.native.ip) {
                            this.castTTS(dev.native.ip, state.val, lang);
                        }
                    }
                } else {
                    let cmd = lang.startsWith('de') ? `Nachricht an alle ${state.val}` : `Broadcast ${state.val}`;
                    this.sendBroadcast(cmd, lang);
                }
                this.setState(id, null, true);
            } 
            
            else if (id.includes('.broadcast')) {
                const deviceId = id.substring(0, id.lastIndexOf('.'));
                const deviceObj = await this.getObjectAsync(deviceId);
                const stateObj = await this.getObjectAsync(id);

                if (stateObj && stateObj.native && stateObj.native.friendlyName) {
                    const langId = id.replace('.broadcast', '.language');
                    const langState = await this.getStateAsync(langId);
                    const lang = (langState && langState.val) ? langState.val : (this.config.language || 'en-US');
                    
                    if (this.config.broadcastMode === 'cast') {
                        if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                            this.castTTS(deviceObj.native.ip, state.val, lang);
                        } else {
                            this.log.warn(`Cannot Cast to ${stateObj.native.friendlyName}: IP missing.`);
                        }
                    } else {
                        const target = stateObj.native.friendlyName;
                        let cmd = lang.startsWith('en') ? `Broadcast to ${target} ${state.val}` : `Broadcast ${state.val}`;
                        this.sendBroadcast(cmd, lang);
                    }
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