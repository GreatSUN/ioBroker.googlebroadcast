'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const axios = require('axios');
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
        
        // Web Server
        this.server = null;
        this.serverPort = 8091;
        this.localIp = '';
        this.audioBuffers = new Map();
    }

    async onReady() {
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_tokens.json`);

        this.serverPort = this.config.webServerPort || 8091;
        
        // Priority: Manual IP -> Dropdown IP -> Auto-detected
        if (this.config.manualIp) {
            this.localIp = this.config.manualIp;
            this.log.info(`Using configured Manual IP: ${this.localIp}`);
        } else if (this.config.webServerIp) {
            this.localIp = this.config.webServerIp;
            this.log.info(`Using configured Web Server IP: ${this.localIp}`);
        } else {
            this.findLocalIp();
        }

        this.startWebServer();

        if (this.config.broadcastMode === 'cast') {
            this.log.info(`Starting in Chromecast TTS Mode. Hosting at http://${this.localIp}:${this.serverPort}`);
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

    findLocalIp() {
        const interfaces = os.networkInterfaces();
        const found = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if ('IPv4' !== iface.family || iface.internal) continue;
                found.push(iface.address);
                if (!this.localIp && !iface.address.startsWith('172.')) { 
                     this.localIp = iface.address;
                }
            }
        }
        if (!this.localIp && found.length > 0) this.localIp = found[0];

        this.log.info(`Auto-detected Local IPs: ${found.join(', ')}. Using: ${this.localIp}`);
    }

    startWebServer() {
        this.server = http.createServer((req, res) => {
            const remoteIp = req.socket.remoteAddress;
            this.log.debug(`Web Server: Incoming request from ${remoteIp} for ${req.url}`);

            const match = req.url.match(/^\/tts\/(.+)\.mp3/);
            if (match && match[1]) {
                const deviceId = match[1];
                const buffer = this.audioBuffers.get(deviceId);
                if (buffer) {
                    res.writeHead(200, {
                        'Content-Type': 'audio/mpeg',
                        'Content-Length': buffer.length
                    });
                    res.end(buffer);
                    this.log.debug(`Web Server: Served TTS audio for device: ${deviceId}`);
                    return;
                } else {
                    this.log.warn(`Web Server: Buffer not found for device ${deviceId}`);
                }
            }
            res.writeHead(404);
            res.end();
        });

        this.server.on('clientError', (err, socket) => {
            this.log.debug(`Web Server: Client Error: ${err.message}`);
            socket.destroy();
        });

        try {
            this.server.listen(this.serverPort, () => {
                this.log.debug(`TTS Web Server listening on port ${this.serverPort}`);
            });
            this.server.on('error', (e) => this.log.error('Web Server Error: ' + e.message));
        } catch (e) {
            this.log.error('Failed to start Web Server: ' + e.message);
        }
    }

    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        const tokenState = await this.getStateAsync('tokens');
        let tokensJson = tokenState && tokenState.val ? tokenState.val : null;
        let tokensObj = null;

        if (tokensJson && typeof tokensJson === 'string' && tokensJson !== '{}') {
            try { tokensObj = JSON.parse(tokensJson); } catch (e) { }
        }

        if (!tokensObj && this.config.authCode && credentialsJson) {
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
            this.log.warn('Assistant not authenticated.');
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
        if (!obj) return;
        this.log.debug(`onMessage received: ${JSON.stringify(obj)}`);

        if (obj.command === 'scan') {
            this.scanNetwork();
            if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'OK' }, obj.callback);
        }
        
        if (obj.command === 'getInterfaces') {
            try {
                const interfaces = os.networkInterfaces();
                const result = [];
                for (const name of Object.keys(interfaces)) {
                    for (const iface of interfaces[name]) {
                        if ('IPv4' === iface.family && !iface.internal) {
                            result.push({ name: name, address: iface.address });
                        }
                    }
                }
                this.log.debug(`Sending interfaces to ${obj.from}: ${JSON.stringify(result)}`);
                if (obj.callback) this.sendTo(obj.from, obj.command, { result: result }, obj.callback);
            } catch (e) {
                this.log.error('Error in getInterfaces: ' + e.message);
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

    async castTTS(deviceId, deviceIp, text, lang, voice) {
        if (!deviceIp) {
            this.log.error(`Cannot Cast to ${deviceId}: IP missing.`);
            return;
        }
        
        const finalLang = lang || this.config.language || 'en-US';
        const speed = this.config.ttsSpeed || 1;
        
        try {
            let buffer = null;

            if (this.config.ttsEngine === 'google_cloud') {
                if (!this.config.googleApiKey) {
                    this.log.error('Google Cloud API Key missing. Please configure in Admin.');
                    return;
                }
                const requestBody = {
                    input: { text: text },
                    voice: { languageCode: finalLang },
                    audioConfig: { audioEncoding: 'MP3', speakingRate: speed }
                };
                if (voice && voice.length > 2) {
                    requestBody.voice.name = voice;
                }
                const apiUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.config.googleApiKey}`;
                const response = await axios.post(apiUrl, requestBody);
                if (response.data && response.data.audioContent) {
                    buffer = Buffer.from(response.data.audioContent, 'base64');
                } else {
                    throw new Error('Google Cloud API returned no audio content.');
                }
            } else {
                const effectiveLang = (voice && voice.length === 2) ? voice : finalLang;
                const ttsUrl = googleTTS.getAudioUrl(text, {
                    lang: effectiveLang,
                    slow: speed < 1,
                    host: 'https://translate.google.com',
                });
                
                this.log.debug(`Downloading Free TTS for ${deviceId}...`);
                const response = await axios.get(ttsUrl, { responseType: 'arraybuffer' });
                buffer = response.data;
            }

            if (!buffer) return;

            this.audioBuffers.set(deviceId, buffer);
            const localUrl = `http://${this.localIp}:${this.serverPort}/tts/${deviceId}.mp3?t=${Date.now()}`;
            this.log.debug(`Casting ${localUrl} to ${deviceIp}`);

            const client = new Client();

            client.on('error', (err) => {
                 this.log.error(`Cast Client Error (${deviceIp}): ${err.message || JSON.stringify(err)}`);
                 try { client.close(); } catch(e) {}
            });

            this.log.debug(`Connecting to Cast Device: ${deviceIp}...`);
            client.connect(deviceIp, () => {
                this.log.debug(`Connected to ${deviceIp}. Fetching sessions...`);
                client.getSessions((err, sessions) => {
                    if (err) {
                        this.log.warn(`Could not get sessions for ${deviceIp}: ${err}. Forcing launch.`);
                        this.launchNew(client, localUrl, false);
                        return;
                    }
                    
                    this.log.debug(`Sessions on ${deviceIp}: ${JSON.stringify(sessions)}`);

                    const active = sessions.find(s => s.appId === 'CC1AD845');
                    const other = sessions.find(s => s.appId !== 'CC1AD845');

                    if (active) {
                        this.log.debug(`DefaultMediaReceiver already active on ${deviceIp}, joining session...`);
                        client.join(active, DefaultMediaReceiver, (err, player) => {
                            if (err) {
                                this.log.warn(`Join failed (${err}), trying to launch new...`);
                                this.launchNew(client, localUrl, false);
                            } else {
                                this.log.debug('Joined existing session successfully.');
                                this.loadMedia(player, localUrl, client);
                            }
                        });
                    } else if (other) {
                        this.log.debug(`Other app active on ${deviceIp}, stopping it...`);
                        client.stop(other, () => {
                             this.log.debug('Stopped other app. Waiting 500ms...');
                             setTimeout(() => this.launchNew(client, localUrl, false), 500); 
                        });
                    } else {
                        this.log.debug('No active session. Launching new...');
                        this.launchNew(client, localUrl, false);
                    }
                });
            });
            
            setTimeout(() => { if(this.audioBuffers.has(deviceId)) this.audioBuffers.delete(deviceId); }, 60000);
            
        } catch (e) {
            this.log.error('TTS Generation Error: ' + e.message);
        }
    }

    launchNew(client, url, retried) {
        this.log.debug('Attempting to Launch DefaultMediaReceiver...');
        client.launch(DefaultMediaReceiver, (err, player) => {
            if (err) {
                if (!retried) {
                    this.log.warn(`Launch failed (${JSON.stringify(err)}). Kicking platform and retrying...`);
                    client.stop({ sessionId: '00000000-0000-0000-0000-000000000000' }, () => {
                        setTimeout(() => this.launchNew(client, url, true), 750);
                    });
                } else {
                    this.log.error(`Launch Error (Persistent): ${err.message || JSON.stringify(err)}`);
                    client.close();
                }
                return;
            }
            this.log.debug('Launch successful. Loading media...');
            this.loadMedia(player, url, client);
        });
    }

    loadMedia(player, url, client) {
        const media = {
            contentId: url,
            contentType: 'audio/mpeg',
            streamType: 'BUFFERED'
        };
        player.load(media, { autoplay: true }, (err, status) => {
            if (err) {
                this.log.error(`Load Error: ${err.message || JSON.stringify(err)}`);
                client.close();
            } else {
                this.log.debug('Media loaded successfully. Playing...');
            }
        });
        player.on('status', (s) => {
            if (s && s.playerState === 'IDLE') {
                this.log.debug('Player Idle. Closing connection.');
                client.close();
            }
        });
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
        
        // Log found devices to help debug Stereo Pair detection
        this.log.debug(`mDNS Discovered: Name="${friendlyName}", Model="${model}", IP=${ip}`);

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isGroup = (model === 'Google Cast Group');
        const folder = isGroup ? 'groups' : 'devices';
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, {
            type: 'device',
            common: { name: friendlyName },
            native: { model: model, ip: ip, port: port }
        });
        
        if (ip) {
            await this.extendObjectAsync(`${folder}.${cleanId}`, { native: { ip: ip, port: port } });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.address`, {
            type: 'state', common: { name: 'IP Address', type: 'string', role: 'info.ip', read: true, write: false }, native: {}
        });
        if (ip) await this.setStateAsync(`${folder}.${cleanId}.address`, ip, true);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.port`, {
            type: 'state', common: { name: 'Port', type: 'number', role: 'info.port', read: true, write: false }, native: {}
        });
        if (port) await this.setStateAsync(`${folder}.${cleanId}.port`, port, true);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, {
            type: 'state', common: { name: `Broadcast to ${friendlyName}`, type: 'string', role: 'text', read: true, write: true }, native: { friendlyName: friendlyName }
        });

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.language`, {
            type: 'state', common: { name: `Language`, type: 'string', role: 'text', read: true, write: true, def: this.config.language || 'en-US' }, native: {}
        });
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.voice`, {
            type: 'state', common: { name: `TTS Voice/Accent`, type: 'string', role: 'text', read: true, write: true, def: '' }, native: {}
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
                            const devIdSimple = dev._id.split('.').pop();
                            this.castTTS(devIdSimple, dev.native.ip, state.val, lang, null);
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
                const simpleId = deviceId.split('.').pop();

                if (stateObj && stateObj.native && stateObj.native.friendlyName) {
                    const langId = id.replace('.broadcast', '.language');
                    const langState = await this.getStateAsync(langId);
                    const lang = (langState && langState.val) ? langState.val : (this.config.language || 'en-US');
                    
                    const voiceId = id.replace('.broadcast', '.voice');
                    const voiceState = await this.getStateAsync(voiceId);
                    const voice = (voiceState && voiceState.val) ? voiceState.val : null;

                    if (this.config.broadcastMode === 'cast') {
                        if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                            this.castTTS(simpleId, deviceObj.native.ip, state.val, lang, voice);
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
            if (this.server) this.server.close();
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